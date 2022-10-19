import { webpack, StringXor } from 'next/dist/compiled/webpack/webpack'
import type { NextConfigComplete } from '../config-shared'
import type { CustomRoutes } from '../../lib/load-custom-routes'
import { getOverlayMiddleware } from 'next/dist/compiled/@next/react-dev-overlay/dist/middleware'
import { IncomingMessage, ServerResponse } from 'http'
import { WebpackHotMiddleware } from './hot-middleware'
import { join, relative, isAbsolute, posix } from 'path'
import { UrlObject } from 'url'
import {
  createEntrypoints,
  createPagesMapping,
  finalizeEntrypoint,
  getClientEntry,
  getEdgeServerEntry,
  getAppEntry,
  runDependingOnPageType,
} from '../../build/entries'
import { watchCompilers } from '../../build/output'
import * as Log from '../../build/output/log'
import getBaseWebpackConfig from '../../build/webpack-config'
import { APP_DIR_ALIAS } from '../../lib/constants'
import { recursiveDelete } from '../../lib/recursive-delete'
import {
  BLOCKED_PAGES,
  COMPILER_NAMES,
  RSC_MODULE_TYPES,
} from '../../shared/lib/constants'
import { __ApiPreviewProps } from '../api-utils'
import { getPathMatch } from '../../shared/lib/router/utils/path-match'
import { findPageFile } from '../lib/find-page-file'
import {
  BUILDING,
  entries,
  EntryTypes,
  getInvalidator,
  onDemandEntryHandler,
} from './on-demand-entry-handler'
import { denormalizePagePath } from '../../shared/lib/page-path/denormalize-page-path'
import { normalizePathSep } from '../../shared/lib/page-path/normalize-path-sep'
import getRouteFromEntrypoint from '../get-route-from-entrypoint'
import { fileExists } from '../../lib/file-exists'
import { difference, isMiddlewareFilename } from '../../build/utils'
import { DecodeError } from '../../shared/lib/utils'
import { Span, trace } from '../../trace'
import { getProperError } from '../../lib/is-error'
import ws from 'next/dist/compiled/ws'
import { promises as fs } from 'fs'
import { getPageStaticInfo } from '../../build/analysis/get-page-static-info'
import { UnwrapPromise } from '../../lib/coalesced-function'

function diff(a: Set<any>, b: Set<any>) {
  return new Set([...a].filter((v) => !b.has(v)))
}

const wsServer = new ws.Server({ noServer: true })

export async function renderScriptError(
  res: ServerResponse,
  error: Error,
  { verbose = true } = {}
) {
  // Asks CDNs and others to not to cache the errored page
  res.setHeader(
    'Cache-Control',
    'no-cache, no-store, max-age=0, must-revalidate'
  )

  if ((error as any).code === 'ENOENT') {
    res.statusCode = 404
    res.end('404 - Not Found')
    return
  }

  if (verbose) {
    console.error(error.stack)
  }
  res.statusCode = 500
  res.end('500 - Internal Error')
}

function addCorsSupport(req: IncomingMessage, res: ServerResponse) {
  // Only rewrite CORS handling when URL matches a hot-reloader middleware
  if (!req.url!.startsWith('/__next')) {
    return { preflight: false }
  }

  if (!req.headers.origin) {
    return { preflight: false }
  }

  res.setHeader('Access-Control-Allow-Origin', req.headers.origin)
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET')
  // Based on https://github.com/primus/access-control/blob/4cf1bc0e54b086c91e6aa44fb14966fa5ef7549c/index.js#L158
  if (req.headers['access-control-request-headers']) {
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] as string
    )
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return { preflight: true }
  }

  return { preflight: false }
}

const matchNextPageBundleRequest = getPathMatch(
  '/_next/static/chunks/pages/:path*.js(\\.map|)'
)

// Recursively look up the issuer till it ends up at the root
function findEntryModule(
  compilation: webpack.Compilation,
  issuerModule: any
): any {
  const issuer = compilation.moduleGraph.getIssuer(issuerModule)
  if (issuer) {
    return findEntryModule(compilation, issuer)
  }

  return issuerModule
}

function erroredPages(compilation: webpack.Compilation) {
  const failedPages: { [page: string]: any[] } = {}
  for (const error of compilation.errors) {
    if (!error.module) {
      continue
    }

    const entryModule = findEntryModule(compilation, error.module)
    const { name } = entryModule
    if (!name) {
      continue
    }

    // Only pages have to be reloaded
    const enhancedName = getRouteFromEntrypoint(name)

    if (!enhancedName) {
      continue
    }

    if (!failedPages[enhancedName]) {
      failedPages[enhancedName] = []
    }

    failedPages[enhancedName].push(error)
  }

  return failedPages
}

export default class HotReloader {
  private dir: string
  private buildId: string
  private interceptors: any[]
  private pagesDir?: string
  private distDir: string
  private webpackHotMiddleware?: WebpackHotMiddleware
  private config: NextConfigComplete
  public hasServerComponents: boolean
  public hasReactRoot: boolean
  public clientStats: webpack.Stats | null
  public serverStats: webpack.Stats | null
  public edgeServerStats: webpack.Stats | null
  private clientError: Error | null = null
  private serverError: Error | null = null
  private serverPrevDocumentHash: string | null
  private prevChunkNames?: Set<any>
  private onDemandEntries?: ReturnType<typeof onDemandEntryHandler>
  private previewProps: __ApiPreviewProps
  private watcher: any
  private rewrites: CustomRoutes['rewrites']
  private fallbackWatcher: any
  private hotReloaderSpan: Span
  private pagesMapping: { [key: string]: string } = {}
  private appDir?: string
  public multiCompiler?: webpack.MultiCompiler
  public activeConfigs?: Array<
    UnwrapPromise<ReturnType<typeof getBaseWebpackConfig>>
  >

  constructor(
    dir: string,
    {
      config,
      pagesDir,
      distDir,
      buildId,
      previewProps,
      rewrites,
      appDir,
    }: {
      config: NextConfigComplete
      pagesDir?: string
      distDir: string
      buildId: string
      previewProps: __ApiPreviewProps
      rewrites: CustomRoutes['rewrites']
      appDir?: string
    }
  ) {
    this.buildId = buildId
    this.dir = dir
    this.interceptors = []
    this.pagesDir = pagesDir
    this.appDir = appDir
    this.distDir = distDir
    this.clientStats = null
    this.serverStats = null
    this.edgeServerStats = null
    this.serverPrevDocumentHash = null

    // ***
    this.config = config // ***
    this.hasReactRoot = !!process.env.__NEXT_REACT_ROOT
    this.hasServerComponents = this.hasReactRoot && !!this.appDir
    this.previewProps = previewProps
    this.rewrites = rewrites
    this.hotReloaderSpan = trace('hot-reloader', undefined, {
      version: process.env.__NEXT_VERSION as string,
    })
    // Ensure the hotReloaderSpan is flushed immediately as it's the parentSpan for all processing
    // of the current `next dev` invocation.
    this.hotReloaderSpan.stop()
  }

  public async run(
    req: IncomingMessage,
    res: ServerResponse,
    parsedUrl: UrlObject
  ): Promise<{ finished?: true }> {
    // Usually CORS support is not needed for the hot-reloader (this is dev only feature)
    // With when the app runs for multi-zones support behind a proxy,
    // the current page is trying to access this URL via assetPrefix.
    // That's when the CORS support is needed.
    const { preflight } = addCorsSupport(req, res)
    if (preflight) {
      return {}
    }

    // When a request comes in that is a page bundle, e.g. /_next/static/<buildid>/pages/index.js
    // we have to compile the page using on-demand-entries, this middleware will handle doing that
    // by adding the page to on-demand-entries, waiting till it's done
    // and then the bundle will be served like usual by the actual route in server/index.js
    const handlePageBundleRequest = async (
      pageBundleRes: ServerResponse,
      parsedPageBundleUrl: UrlObject
    ): Promise<{ finished?: true }> => {
      const { pathname } = parsedPageBundleUrl
      const params = matchNextPageBundleRequest<{ path: string[] }>(pathname)
      if (!params) {
        return {}
      }

      let decodedPagePath: string

      try {
        decodedPagePath = `/${params.path
          .map((param) => decodeURIComponent(param))
          .join('/')}`
      } catch (_) {
        throw new DecodeError('failed to decode param')
      }

      const page = denormalizePagePath(decodedPagePath)

      if (page === '/_error' || BLOCKED_PAGES.indexOf(page) === -1) {
        try {
          await this.ensurePage({ page, clientOnly: true })
        } catch (error) {
          await renderScriptError(pageBundleRes, getProperError(error))
          return { finished: true }
        }

        const errors = await this.getCompilationErrors(page)
        if (errors.length > 0) {
          await renderScriptError(pageBundleRes, errors[0], { verbose: false })
          return { finished: true }
        }
      }

      return {}
    }

    const { finished } = await handlePageBundleRequest(res, parsedUrl)

    for (const fn of this.interceptors) {
      await new Promise<void>((resolve, reject) => {
        fn(req, res, (err: Error) => {
          if (err) return reject(err)
          resolve()
        })
      })
    }

    return { finished }
  }

  public onHMR(req: IncomingMessage, _res: ServerResponse, head: Buffer) {
    wsServer.handleUpgrade(req, req.socket, head, (client) => {
      this.webpackHotMiddleware?.onHMR(client)
      this.onDemandEntries?.onHMR(client)

      client.addEventListener('message', ({ data }) => {
        data = typeof data !== 'string' ? data.toString() : data

        try {
          const payload = JSON.parse(data)

          let traceChild:
            | {
                name: string
                startTime?: bigint
                endTime?: bigint
                attrs?: Record<string, number | string>
              }
            | undefined

          switch (payload.event) {
            case 'client-hmr-latency': {
              traceChild = {
                name: payload.event,
                startTime: BigInt(payload.startTime * 1000 * 1000),
                endTime: BigInt(payload.endTime * 1000 * 1000),
              }
              break
            }
            case 'client-reload-page':
            case 'client-success': {
              traceChild = {
                name: payload.event,
              }
              break
            }
            case 'client-error': {
              traceChild = {
                name: payload.event,
                attrs: { errorCount: payload.errorCount },
              }
              break
            }
            case 'client-warning': {
              traceChild = {
                name: payload.event,
                attrs: { warningCount: payload.warningCount },
              }
              break
            }
            case 'client-removed-page':
            case 'client-added-page': {
              traceChild = {
                name: payload.event,
                attrs: { page: payload.page || '' },
              }
              break
            }
            case 'client-full-reload': {
              traceChild = {
                name: payload.event,
                attrs: { stackTrace: payload.stackTrace ?? '' },
              }
              Log.warn(
                'Fast Refresh had to perform a full reload. Read more: https://nextjs.org/docs/basic-features/fast-refresh#how-it-works'
              )
              if (payload.stackTrace) {
                console.warn(payload.stackTrace)
              }
              break
            }
            default: {
              break
            }
          }

          if (traceChild) {
            this.hotReloaderSpan.manualTraceChild(
              traceChild.name,
              traceChild.startTime || process.hrtime.bigint(),
              traceChild.endTime || process.hrtime.bigint(),
              { ...traceChild.attrs, clientId: payload.id }
            )
          }
        } catch (_) {
          // invalid WebSocket message
        }
      })
    })
  }

  private async clean(span: Span): Promise<void> {
    return span
      .traceChild('clean')
      .traceAsyncFn(() =>
        recursiveDelete(join(this.dir, this.config.distDir), /^cache/)
      )
  }

  private async getWebpackConfig(span: Span) {
    const webpackConfigSpan = span.traceChild('get-webpack-config')

    // ['tsx', 'ts', 'jsx', 'js']
    const pageExtensions = this.config.pageExtensions

    return webpackConfigSpan.traceAsyncFn(async () => {

      // 默认什么都没有配置得到的结果
      // ['/_app.js', null]
      const pagePaths = !this.pagesDir
        ? ([] as (string | null)[])
        : await webpackConfigSpan
            .traceChild('get-page-paths')
            .traceAsyncFn(() =>
              Promise.all([
                // pagesDir -> 工程目录/pages
                findPageFile(this.pagesDir!, '/_app', pageExtensions, false),
                findPageFile(
                  this.pagesDir!,
                  '/_document',
                  pageExtensions,
                  false
                ),
              ])
            )
      
      /**
       * 
        { 
          /_app: "private-next-pages/_app"
          /_document: "private-next-pages/_document"
          /_error: "private-next-pages/_error"
        }
       * 
       */
      this.pagesMapping = webpackConfigSpan
        .traceChild('create-pages-mapping')
        .traceFn(() =>
          createPagesMapping({
            isDev: true,
            pageExtensions: this.config.pageExtensions,
            pagesType: 'pages',
            pagePaths: pagePaths.filter(
              (i: string | null): i is string => typeof i === 'string'
            ),
            pagesDir: this.pagesDir,
          })
        )

      /**
       * 
       * 
       * {
              "client": {
                  "pages/_app": [
                      "next-client-pages-loader?absolutePagePath=private-next-pages%2F_app&page=%2F_app!",
                      "/home/projects/nextjs-hwpjy6/node_modules/next/dist/client/router.js"
                  ],
                  "pages/_error": "next-client-pages-loader?absolutePagePath=private-next-pages%2F_error&page=%2F_error!"
              },
              "server": {
                  "pages/_app": [
                      "private-next-pages/_app"
                  ],
                  "pages/_error": [
                      "private-next-pages/_error"
                  ],
                  "pages/_document": [
                      "private-next-pages/_document"
                  ]
              },
              "edgeServer": {}
          }
       * 
       * 
       */
      const entrypoints = await webpackConfigSpan
        .traceChild('create-entrypoints')
        .traceAsyncFn(() =>
          createEntrypoints({ // next/build/entries.ts
            appDir: this.appDir,
            buildId: this.buildId,
            config: this.config,
            envFiles: [],
            isDev: true,
            pages: this.pagesMapping,
            pagesDir: this.pagesDir,
            previewMode: this.previewProps,
            rootDir: this.dir,
            target: 'server',
            pageExtensions: this.config.pageExtensions,
          })
        )

      const commonWebpackOptions = {
        dev: true,
        buildId: this.buildId,
        config: this.config,
        hasReactRoot: this.hasReactRoot, // true
        pagesDir: this.pagesDir, // "/home/projects/nextjs-hwpjy6/pages"
        rewrites: this.rewrites,
        runWebpackSpan: this.hotReloaderSpan,
        appDir: this.appDir, // undefined
      }

      // 生成webpack配置
      return webpackConfigSpan
        .traceChild('generate-webpack-config')
        .traceAsyncFn(() =>
          Promise.all([
            // 顺序在这里是很重要的
            // order is important here
            getBaseWebpackConfig(this.dir, { // next/build/webpack-config.ts
              ...commonWebpackOptions,
              compilerType: COMPILER_NAMES.client, // 'client'
              entrypoints: entrypoints.client,
            }),
            getBaseWebpackConfig(this.dir, {
              ...commonWebpackOptions,
              compilerType: COMPILER_NAMES.server, // 'server'
              entrypoints: entrypoints.server,
            }),
            getBaseWebpackConfig(this.dir, {
              ...commonWebpackOptions,
              compilerType: COMPILER_NAMES.edgeServer, // 'edge-server'
              entrypoints: entrypoints.edgeServer,
            }),
          ])
        )
    })
  }

  public async buildFallbackError(): Promise<void> {
    if (this.fallbackWatcher) return

    const fallbackConfig = await getBaseWebpackConfig(this.dir, {
      runWebpackSpan: this.hotReloaderSpan,
      dev: true,
      compilerType: COMPILER_NAMES.client,
      config: this.config,
      buildId: this.buildId,
      pagesDir: this.pagesDir,
      rewrites: {
        beforeFiles: [],
        afterFiles: [],
        fallback: [],
      },
      isDevFallback: true,
      entrypoints: (
        await createEntrypoints({
          appDir: this.appDir,
          buildId: this.buildId,
          config: this.config,
          envFiles: [],
          isDev: true,
          pages: {
            '/_app': 'next/dist/pages/_app',
            '/_error': 'next/dist/pages/_error',
          },
          pagesDir: this.pagesDir,
          previewMode: this.previewProps,
          rootDir: this.dir,
          target: 'server',
          pageExtensions: this.config.pageExtensions,
        })
      ).client,
      hasReactRoot: this.hasReactRoot,
    })
    const fallbackCompiler = webpack(fallbackConfig)

    this.fallbackWatcher = await new Promise((resolve) => {
      let bootedFallbackCompiler = false
      fallbackCompiler.watch(
        // @ts-ignore webpack supports an array of watchOptions when using a multiCompiler
        fallbackConfig.watchOptions,
        // Errors are handled separately
        (_err: any) => {
          if (!bootedFallbackCompiler) {
            bootedFallbackCompiler = true
            resolve(true)
          }
        }
      )
    })
  }

  public async start(initial?: boolean): Promise<void> {
    const startSpan = this.hotReloaderSpan.traceChild('start')
    startSpan.stop() // Stop immediately to create an artificial parent span

    // 第一次也就是在next-dev-server.ts中执行所传入的是true
    if (initial) {
      await this.clean(startSpan)
      // Ensure distDir exists before writing package.json
      await fs.mkdir(this.distDir, { recursive: true }) // 确保.next目录是存在的

      const distPackageJsonPath = join(this.distDir, 'package.json')
      // Ensure commonjs handling is used for files in the distDir (generally .next)
      // Files outside of the distDir can be "type": "module"
      await fs.writeFile(distPackageJsonPath, '{"type": "commonjs"}') // 写入.next/package.json文件
    }

    // ***
    // 获取webpack配置
    // 产出的具体的webpack的配置可以在// next/build/webpack-config.ts下getBaseWebpackConfig中具体去查看详细的配置逻辑过程
    // ***
    this.activeConfigs = await this.getWebpackConfig(startSpan)

    for (const config of this.activeConfigs) {
      const defaultEntry = config.entry
      // ***
      config.entry = async (...args) => {
        // @ts-ignore entry is always a function
        // ***
        // 这里一直都是默认的入口点，一成不变的
        // ***
        const entrypoints = await defaultEntry(...args) // ***
        const isClientCompilation = config.name === COMPILER_NAMES.client
        const isNodeServerCompilation = config.name === COMPILER_NAMES.server
        const isEdgeServerCompilation =
          config.name === COMPILER_NAMES.edgeServer

        await Promise.all(

          // ************
          /// 取得是entries，它是在server/dev/on-demand-entry-handler.ts中的
          // ************
          // 
          /**
           * 
           * {
           * clien/
           * 
           * {
                "type": 0,
                "appPaths": null,
                "absolutePagePath": "/home/projects/nextjs-hwpjy6/pages/index.js",
                "request": "/home/projects/nextjs-hwpjy6/pages/index.js",
                "bundlePath": "pages/index",
                "dispose": false,
                "lastActiveTime": 1666101599299
            }

            server/
            {
                "type": 0,
                "appPaths": null,
                "absolutePagePath": "/home/projects/nextjs-hwpjy6/pages/index.js",
                "request": "/home/projects/nextjs-hwpjy6/pages/index.js",
                "bundlePath": "pages/index",
                "dispose": false,
                "lastActiveTime": 1666101599299
            }
      }
           * 
           * 
           */// 特别注意：这里取得是entries，它是在server/dev/on-demand-entry-handler.ts下导出的
          Object.keys(entries).map(async (entryKey) => {
            const entryData = entries[entryKey]
            const { bundlePath, dispose } = entryData

            const result = /^(client|server|edge-server)(.*)/g.exec(entryKey)
            const [, key, page] = result! // this match should always happen
            if (key === COMPILER_NAMES.client && !isClientCompilation) return
            if (key === COMPILER_NAMES.server && !isNodeServerCompilation)
              return
            if (key === COMPILER_NAMES.edgeServer && !isEdgeServerCompilation)
              return

            const isEntry = entryData.type === EntryTypes.ENTRY
            const isChildEntry = entryData.type === EntryTypes.CHILD_ENTRY

            // Check if the page was removed or disposed and remove it
            if (isEntry) {
              const pageExists =
                !dispose && (await fileExists(entryData.absolutePagePath))
              if (!pageExists) {
                delete entries[entryKey]
                return
              }
            }

            const hasAppDir = !!this.appDir
            const isAppPath = hasAppDir && bundlePath.startsWith('app/')
            const staticInfo = isEntry
              ? await getPageStaticInfo({
                  pageFilePath: entryData.absolutePagePath,
                  nextConfig: this.config,
                  isDev: true,
                })
              : {}
            const isServerComponent =
              isAppPath && staticInfo.rsc !== RSC_MODULE_TYPES.client

            await runDependingOnPageType({
              page,
              pageRuntime: staticInfo.runtime,
              onEdgeServer: () => {
                // TODO-APP: verify if child entry should support.
                if (!isEdgeServerCompilation || !isEntry) return
                const appDirLoader = isAppPath
                  ? getAppEntry({
                      name: bundlePath,
                      appPaths: entryData.appPaths,
                      pagePath: posix.join(
                        APP_DIR_ALIAS,
                        relative(
                          this.appDir!,
                          entryData.absolutePagePath
                        ).replace(/\\/g, '/')
                      ),
                      appDir: this.appDir!,
                      pageExtensions: this.config.pageExtensions,
                    }).import
                  : undefined

                entries[entryKey].status = BUILDING
                entrypoints[bundlePath] = finalizeEntrypoint({
                  compilerType: COMPILER_NAMES.edgeServer,
                  name: bundlePath,
                  value: getEdgeServerEntry({
                    absolutePagePath: entryData.absolutePagePath,
                    rootDir: this.dir,
                    buildId: this.buildId,
                    bundlePath,
                    config: this.config,
                    isDev: true,
                    page,
                    pages: this.pagesMapping,
                    isServerComponent,
                    appDirLoader,
                    pagesType: isAppPath ? 'app' : 'pages',
                  }),
                  hasAppDir,
                })
              },
              onClient: () => {
                if (!isClientCompilation) return
                if (isChildEntry) {
                  entries[entryKey].status = BUILDING
                  entrypoints[bundlePath] = finalizeEntrypoint({
                    name: bundlePath,
                    compilerType: COMPILER_NAMES.client,
                    value: entryData.request,
                    hasAppDir,
                  })
                } else {
                  // server/dev/on-demand-entry-handler.ts下的entries
                  // ***
                  entries[entryKey].status = BUILDING
                  entrypoints[bundlePath] = finalizeEntrypoint({
                    name: bundlePath,
                    compilerType: COMPILER_NAMES.client,
                    value: getClientEntry({
                      absolutePagePath: entryData.absolutePagePath,
                      page,
                    }),
                    hasAppDir,
                  })
                }
              },
              onServer: () => {
                // TODO-APP: verify if child entry should support.
                if (!isNodeServerCompilation || !isEntry) return
                // ***
                entries[entryKey].status = BUILDING
                let relativeRequest = relative(
                  config.context!,
                  entryData.absolutePagePath
                )
                if (
                  !isAbsolute(relativeRequest) &&
                  !relativeRequest.startsWith('../')
                ) {
                  relativeRequest = `./${relativeRequest}`
                }

                entrypoints[bundlePath] = finalizeEntrypoint({
                  compilerType: COMPILER_NAMES.server,
                  name: bundlePath,
                  isServerComponent,
                  value: isAppPath
                    ? getAppEntry({
                        name: bundlePath,
                        appPaths: entryData.appPaths,
                        pagePath: posix.join(
                          APP_DIR_ALIAS,
                          relative(
                            this.appDir!,
                            entryData.absolutePagePath
                          ).replace(/\\/g, '/')
                        ),
                        appDir: this.appDir!,
                        pageExtensions: this.config.pageExtensions,
                      })
                    : relativeRequest,
                  hasAppDir,
                })
              },
            })
          })
        )
        /**
         * 
         * 
         *
          client
          {
            amp: {import: './node_modules/next/dist/client/dev/amp-dev'}
            main: {import: './node_modules/next/dist/client/next-dev.js'} // ***
            pages/_app: {dependOn: 'main', import: [
              "next-client-pages-loader?absolutePagePath=private-next-pages%2F_app&page=%2F_app!",
              "/home/projects/nextjs-hwpjy6/node_modules/next/dist/client/router.js"
            ]}
            pages/_error: {dependOn: 'pages/_app', import: 'next-client-pages-loader?absolutePagePath=private-next-pages%2F_error&page=%2F_error!'}
            react-refresh: {import: '/home/projects/nextjs-hwpjy6/node_modules/next/dis…ompiled/@next/react-refresh-utils/dist/runtime.js'}
          }
          ❯ npm run dev // 注意：此时没有打开浏览器访问该地址的操作
          $ next dev
          ready - started server on 0.0.0.0:3000, url: http://localhost:3000
          info  - Disabled SWC as replacement for Babel because of custom Babel configuration ".babelrc" https://nextjs.org/docs/messages/swc-disabled
          info  - Using external babel configuration from /home/projects/nextjs-hwpjy6/.babelrc
          event - compiled client and server successfully in 4.1s (173 modules)
          ❯ ls .next/static/chunks/pages/
          _app.js    _error.js

          // --- 他这里实现了一个按需要进行编译的功能 -> 就是请求到来比如/ -> 这次就多了些模块，比如.next/static/chunks/pages/index.js
          // 这个是在next-dev-server.ts中的findPageComponents函数中的this.hotReloader!.ensurePage中做的功能逻辑，详细查看server/dev/on-demand-entry-handler.ts详细说明
          // ***

          server
          {
            pages/_app: {publicPath: undefined, runtime: 'webpack-runtime', layer: undefined, import: ["private-next-pages/_app"]} // ***这是在webpack-config.ts中的customAppAliases和customDocumentAliases在webpack配置对象的resolve.alias中定义的
            // 再配合resolve.modules属性
            // ***其实就是工程目录/pages/_app.js - 具体查看webpack-config.ts下的customAppAliases变量***
            // 以工程目录下的文件为最高优先级，最后才是next/dist/pages/_app.js这个的，是不一样的
            pages/_document: {publicPath: undefined, runtime: 'webpack-runtime', layer: undefined, import: ["private-next-pages/_document"]}
            // ***其实就是next/dist/pages/_document.js***
            pages/_error: {publicPath: undefined, runtime: 'webpack-runtime', layer: undefined, import: ["private-next-pages/_error"]}
          }

          edge-server
          {}



          当发出 req /
          client
          {
            ..., // 还是上面那些默认的入口点
            pages/index: { // 这个是根据请求url / 来去产生的
    "dependOn": "pages/_app",
    "import": "next-client-pages-loader?absolutePagePath=%2Fhome%2Fprojects%2Fnextjs-hwpjy6%2Fpages%2Findex.js&page=%2F!" // 这个是在entries.ts中的getClientEntry函数中生成的
    // ***是在webpack-config.ts中的webpack配置对象里面的resolveLoader.alias中添加的next-client-pages-loader这个loader来去处理的
}
          }

          server
          {
            ...,
            pages/index: {
              publicPath: undefined,
    "runtime": "webpack-runtime",
    "import": "./pages/index.js" // 依据工程目录下的相对路径
    // 工程路径/pages/index.js -> "import": "./pages/index.js"
    // 工程路径/pages/index.jsx -> "import": "./pages/index.jsx"
    // ***
    // ***因为在getBaseWebpackConfig函数中的webpack配置里面有一个参数是context，它的值就是当前工程路径***
    // 所以这也就说明了.next/server/pages/index.js文件出现的原因所在
    // ***
    layer: undefined
}
          }


         * 
         * 
         */
        return entrypoints
      }
    }

    // ***
    // dev
    // client output.path -> .next - output.chunkFilename -> static/chunks/[name].js - output.filename -> static/chunks/[name].js
    // server output.path -> .next/server - output.chunkFilename -> [name].js - output.filename -> [name].js

    // dev下对于一些清单（xxxManifest.json）是通过***webpack plugin***来去做的，具体查看next/build/webpack-config.ts内的详细配置
    // ***

    // Enable building of client compilation before server compilation in development
    // @ts-ignore webpack 5
    this.activeConfigs.parallelism = 1

    /**
     * 
     * 
     * dev /
     * 
     * 响应html
     * 
     *  <!DOCTYPE html>
        <html>
            <head>
                <script src="/.localservice@runtime.3e4f172269cb19a250be0dfdff1ab657cb850d0e.js"></script>
                <style data-next-hide-fouc="true">
                    body {
                        display: none
                    }
                </style>
                <noscript data-next-hide-fouc="true">
                    <style>
                        body {
                            display: block
                        }
                    </style>
                </noscript>
                <meta charSet="utf-8"/>
                <meta name="viewport" content="width=device-width"/>
                <title>Create Next App</title>
                <meta name="next-head-count" content="3"/>
                <noscript data-n-css=""></noscript>
                <script defer="" nomodule="" src="/_next/static/chunks/polyfills.js?ts=1666095276958"></script>
                <script src="/_next/static/chunks/webpack.js?ts=1666095276958" defer=""></script>
                <script src="/_next/static/chunks/main.js?ts=1666095276958" defer=""></script>
                <script src="/_next/static/chunks/pages/_app.js?ts=1666095276958" defer=""></script>
                <script src="/_next/static/chunks/pages/index.js?ts=1666095276958" defer=""></script>
                <script src="/_next/static/development/_buildManifest.js?ts=1666095276958" defer=""></script>
                <script src="/_next/static/development/_ssgManifest.js?ts=1666095276958" defer=""></script>
                <noscript id="__next_css__DO_NOT_USE__"></noscript>
            </head>
            <body>
                <div id="__next">
                    <div class="Home_container__bCOhY"></div>
                </div>
                <script src="/_next/static/chunks/react-refresh.js?ts=1666095276958"></script>
                <script id="__NEXT_DATA__" type="application/json">
                    {"props":{"pageProps":{}},"page":"/","query":{},"buildId":"development","nextExport":true,"autoExport":true,"isFallback":false,"scriptLoader":[]}
                </script>
            </body>
        </html>

     * 
     * 
     */

    // 执行webpack函数，传入配置
    this.multiCompiler = webpack(
      this.activeConfigs
    ) as unknown as webpack.MultiCompiler

    // 观察这些编译者们
    watchCompilers(
      this.multiCompiler.compilers[0],
      this.multiCompiler.compilers[1],
      this.multiCompiler.compilers[2]
    )

    // Watch for changes to client/server page files so we can tell when just
    // the server file changes and trigger a reload for GS(S)P pages
    const changedClientPages = new Set<string>()
    const changedServerPages = new Set<string>()
    const changedEdgeServerPages = new Set<string>()
    const changedCSSImportPages = new Set<string>()

    const prevClientPageHashes = new Map<string, string>()
    const prevServerPageHashes = new Map<string, string>()
    const prevEdgeServerPageHashes = new Map<string, string>()
    const prevCSSImportModuleHashes = new Map<string, string>()

    const trackPageChanges =
      (pageHashMap: Map<string, string>, changedItems: Set<string>) =>
      (stats: webpack.Compilation) => {
        try {
          stats.entrypoints.forEach((entry, key) => {
            if (
              key.startsWith('pages/') ||
              key.startsWith('app/') ||
              isMiddlewareFilename(key)
            ) {
              // TODO this doesn't handle on demand loaded chunks
              entry.chunks.forEach((chunk) => {
                if (chunk.id === key) {
                  const modsIterable: any =
                    stats.chunkGraph.getChunkModulesIterable(chunk)

                  let hasCSSModuleChanges = false
                  let chunksHash = new StringXor()

                  modsIterable.forEach((mod: any) => {
                    if (
                      mod.resource &&
                      mod.resource.replace(/\\/g, '/').includes(key)
                    ) {
                      // use original source to calculate hash since mod.hash
                      // includes the source map in development which changes
                      // every time for both server and client so we calculate
                      // the hash without the source map for the page module
                      const hash = require('crypto')
                        .createHash('sha256')
                        .update(mod.originalSource().buffer())
                        .digest()
                        .toString('hex')

                      chunksHash.add(hash)
                    } else {
                      // for non-pages we can use the module hash directly
                      const hash = stats.chunkGraph.getModuleHash(
                        mod,
                        chunk.runtime
                      )
                      chunksHash.add(hash)

                      // Both CSS import changes from server and client
                      // components are tracked.
                      if (
                        key.startsWith('app/') &&
                        mod.resource?.endsWith('.css')
                      ) {
                        const prevHash = prevCSSImportModuleHashes.get(
                          mod.resource
                        )
                        if (prevHash && prevHash !== hash) {
                          hasCSSModuleChanges = true
                        }
                        prevCSSImportModuleHashes.set(mod.resource, hash)
                      }
                    }
                  })
                  const prevHash = pageHashMap.get(key)
                  const curHash = chunksHash.toString()

                  if (prevHash && prevHash !== curHash) {
                    changedItems.add(key)
                  }
                  pageHashMap.set(key, curHash)

                  if (hasCSSModuleChanges) {
                    changedCSSImportPages.add(key)
                  }
                }
              })
            }
          })
        } catch (err) {
          console.error(err)
        }
      }

    this.multiCompiler.compilers[0].hooks.emit.tap(
      'NextjsHotReloaderForClient',
      trackPageChanges(prevClientPageHashes, changedClientPages)
    )
    this.multiCompiler.compilers[1].hooks.emit.tap(
      'NextjsHotReloaderForServer',
      trackPageChanges(prevServerPageHashes, changedServerPages)
    )
    this.multiCompiler.compilers[2].hooks.emit.tap(
      'NextjsHotReloaderForServer',
      trackPageChanges(prevEdgeServerPageHashes, changedEdgeServerPages)
    )

    // This plugin watches for changes to _document.js and notifies the client side that it should reload the page
    this.multiCompiler.compilers[1].hooks.failed.tap(
      'NextjsHotReloaderForServer',
      (err: Error) => {
        this.serverError = err
        this.serverStats = null
      }
    )

    this.multiCompiler.compilers[2].hooks.done.tap(
      'NextjsHotReloaderForServer',
      (stats) => {
        this.serverError = null
        this.edgeServerStats = stats
      }
    )

    this.multiCompiler.compilers[1].hooks.done.tap(
      'NextjsHotReloaderForServer',
      (stats) => {
        this.serverError = null
        this.serverStats = stats

        if (!this.pagesDir) {
          return
        }

        const { compilation } = stats

        // We only watch `_document` for changes on the server compilation
        // the rest of the files will be triggered by the client compilation
        const documentChunk = compilation.namedChunks.get('pages/_document')
        // If the document chunk can't be found we do nothing
        if (!documentChunk) {
          console.warn('_document.js chunk not found')
          return
        }

        // Initial value
        if (this.serverPrevDocumentHash === null) {
          this.serverPrevDocumentHash = documentChunk.hash || null
          return
        }

        // If _document.js didn't change we don't trigger a reload
        if (documentChunk.hash === this.serverPrevDocumentHash) {
          return
        }

        // Notify reload to reload the page, as _document.js was changed (different hash)
        this.send('reloadPage')
        this.serverPrevDocumentHash = documentChunk.hash || null
      }
    )
    this.multiCompiler.hooks.done.tap('NextjsHotReloaderForServer', () => {
      const serverOnlyChanges = difference<string>(
        changedServerPages,
        changedClientPages
      )
      const edgeServerOnlyChanges = difference<string>(
        changedEdgeServerPages,
        changedClientPages
      )
      const serverComponentChanges = serverOnlyChanges
        .concat(edgeServerOnlyChanges)
        .filter((key) => key.startsWith('app/'))
        .concat(Array.from(changedCSSImportPages))
      const pageChanges = serverOnlyChanges.filter((key) =>
        key.startsWith('pages/')
      )
      const middlewareChanges = Array.from(changedEdgeServerPages).filter(
        (name) => isMiddlewareFilename(name)
      )

      changedClientPages.clear()
      changedServerPages.clear()
      changedEdgeServerPages.clear()
      changedCSSImportPages.clear()

      if (middlewareChanges.length > 0) {
        this.send({
          event: 'middlewareChanges',
        })
      }

      if (pageChanges.length > 0) {
        this.send({
          event: 'serverOnlyChanges',
          pages: serverOnlyChanges.map((pg) =>
            denormalizePagePath(pg.slice('pages'.length))
          ),
        })
      }

      if (serverComponentChanges.length > 0) {
        this.send({
          action: 'serverComponentChanges',
          // TODO: granular reloading of changes
          // entrypoints: serverComponentChanges,
        })
      }
    })

    this.multiCompiler.compilers[0].hooks.failed.tap(
      'NextjsHotReloaderForClient',
      (err: Error) => {
        this.clientError = err
        this.clientStats = null
      }
    )
    this.multiCompiler.compilers[0].hooks.done.tap(
      'NextjsHotReloaderForClient',
      (stats) => {
        this.clientError = null
        this.clientStats = stats

        const { compilation } = stats
        const chunkNames = new Set(
          [...compilation.namedChunks.keys()].filter(
            (name) => !!getRouteFromEntrypoint(name)
          )
        )

        if (this.prevChunkNames) {
          // detect chunks which have to be replaced with a new template
          // e.g, pages/index.js <-> pages/_error.js
          const addedPages = diff(chunkNames, this.prevChunkNames!)
          const removedPages = diff(this.prevChunkNames!, chunkNames)

          if (addedPages.size > 0) {
            for (const addedPage of addedPages) {
              const page = getRouteFromEntrypoint(addedPage)
              this.send('addedPage', page)
            }
          }

          if (removedPages.size > 0) {
            for (const removedPage of removedPages) {
              const page = getRouteFromEntrypoint(removedPage)
              this.send('removedPage', page)
            }
          }
        }

        this.prevChunkNames = chunkNames
      }
    )

    // 对多编译者使用webpack hot middleware
    this.webpackHotMiddleware = new WebpackHotMiddleware(
      this.multiCompiler.compilers
    )

    let booted = false

    // ***
    this.watcher = await new Promise((resolve) => {
      // ***
      // 执行watch函数
      // ***
      const watcher = this.multiCompiler?.watch(
        // @ts-ignore webpack supports an array of watchOptions when using a multiCompiler
        this.activeConfigs.map((config) => config.watchOptions!),
        // Errors are handled separately
        (_err: any) => {
          if (!booted) {
            booted = true
            resolve(watcher)
          }
        }
      )
    })

    // ***
    // 当索取、需要入口处理者
    this.onDemandEntries = onDemandEntryHandler({
      multiCompiler: this.multiCompiler,
      pagesDir: this.pagesDir,
      appDir: this.appDir,
      rootDir: this.dir,
      nextConfig: this.config,
      ...(this.config.onDemandEntries as {
        maxInactiveAge: number
        pagesBufferLength: number
      }),
    })

    this.interceptors = [
      getOverlayMiddleware({
        rootDirectory: this.dir,
        stats: () => this.clientStats,
        serverStats: () => this.serverStats,
        edgeServerStats: () => this.edgeServerStats,
      }),
    ]

    // trigger invalidation to ensure any previous callbacks
    // are handled in the on-demand-entry-handler
    if (!initial) {
      this.invalidate()
    }
  }

  public invalidate() {
    return getInvalidator()?.invalidate()
  }

  public async stop(): Promise<void> {
    await new Promise((resolve, reject) => {
      this.watcher.close((err: any) => (err ? reject(err) : resolve(true)))
    })

    if (this.fallbackWatcher) {
      await new Promise((resolve, reject) => {
        this.fallbackWatcher.close((err: any) =>
          err ? reject(err) : resolve(true)
        )
      })
    }
    this.multiCompiler = undefined
  }

  public async getCompilationErrors(page: string) {
    const getErrors = ({ compilation }: webpack.Stats) => {
      const failedPages = erroredPages(compilation)
      const normalizedPage = normalizePathSep(page)
      // If there is an error related to the requesting page we display it instead of the first error
      return failedPages[normalizedPage]?.length > 0
        ? failedPages[normalizedPage]
        : compilation.errors
    }

    if (this.clientError || this.serverError) {
      return [this.clientError || this.serverError]
    } else if (this.clientStats?.hasErrors()) {
      return getErrors(this.clientStats)
    } else if (this.serverStats?.hasErrors()) {
      return getErrors(this.serverStats)
    } else if (this.edgeServerStats?.hasErrors()) {
      return getErrors(this.edgeServerStats)
    } else {
      return []
    }
  }

  public send(action?: string | any, ...args: any[]): void {
    this.webpackHotMiddleware!.publish(
      action && typeof action === 'object' ? action : { action, data: args }
    )
  }

  public async ensurePage({
    page,
    clientOnly,
    appPaths,
  }: {
    page: string
    clientOnly: boolean
    appPaths?: string[] | null
  }): Promise<void> {
    // Make sure we don't re-build or dispose prebuilt pages
    if (page !== '/_error' && BLOCKED_PAGES.indexOf(page) !== -1) {
      return
    }
    const error = clientOnly
      ? this.clientError
      : this.serverError || this.clientError
    if (error) {
      return Promise.reject(error)
    }
    // 在start函数里面赋值
    return this.onDemandEntries?.ensurePage({ // 确保页面
      page, // '/'
      clientOnly,
      appPaths,
    }) as any
  }
}
