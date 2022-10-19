import type { ComponentType } from 'react'
import type { MiddlewareMatcher } from '../build/analysis/get-page-static-info'
import getAssetPathFromRoute from '../shared/lib/router/utils/get-asset-path-from-route'
import { __unsafeCreateTrustedScriptURL } from './trusted-types'
import { requestIdleCallback } from './request-idle-callback'

// 3.8s was arbitrarily chosen as it's what https://web.dev/interactive
// considers as "Good" time-to-interactive. We must assume something went
// wrong beyond this point, and then fall-back to a full page transition to
// show the user something of value.
const MS_MAX_IDLE_DELAY = 3800

declare global {
  interface Window {
    __BUILD_MANIFEST?: Record<string, string[]>
    __BUILD_MANIFEST_CB?: Function
    __MIDDLEWARE_MATCHERS?: MiddlewareMatcher[]
    __MIDDLEWARE_MANIFEST_CB?: Function
  }
}

interface LoadedEntrypointSuccess {
  component: ComponentType
  exports: any
}
interface LoadedEntrypointFailure {
  error: unknown
}
type RouteEntrypoint = LoadedEntrypointSuccess | LoadedEntrypointFailure

interface RouteStyleSheet {
  href: string
  content: string
}

interface LoadedRouteSuccess extends LoadedEntrypointSuccess {
  styles: RouteStyleSheet[]
}
interface LoadedRouteFailure {
  error: unknown
}
type RouteLoaderEntry = LoadedRouteSuccess | LoadedRouteFailure

interface Future<V> {
  resolve: (entrypoint: V) => void
  future: Promise<V>
}
function withFuture<T>(
  key: string,
  map: Map<string, Future<T> | T>,
  generator?: () => Promise<T>
): Promise<T> {
  let entry: Future<T> | T | undefined = map.get(key)
  if (entry) {
    if ('future' in entry) {
      return entry.future
    }
    return Promise.resolve(entry)
  }
  let resolver: (entrypoint: T) => void
  const prom: Promise<T> = new Promise<T>((resolve) => {
    resolver = resolve
  })
  map.set(key, (entry = { resolve: resolver!, future: prom }))
  return generator
    ? generator()
        // eslint-disable-next-line no-sequences
        .then((value) => (resolver(value), value))
        .catch((err) => {
          map.delete(key)
          throw err
        })
    : prom
}

export interface RouteLoader {
  whenEntrypoint(route: string): Promise<RouteEntrypoint>
  onEntrypoint(route: string, execute: () => unknown): void
  loadRoute(route: string, prefetch?: boolean): Promise<RouteLoaderEntry>
  prefetch(route: string): Promise<void>
}

function hasPrefetch(link?: HTMLLinkElement): boolean {
  try {
    link = document.createElement('link')
    return (
      // detect IE11 since it supports prefetch but isn't detected
      // with relList.support
      (!!window.MSInputMethodContext && !!(document as any).documentMode) ||
      link.relList.supports('prefetch')
    )
  } catch {
    return false
  }
}

const canPrefetch: boolean = hasPrefetch()

function prefetchViaDom(
  href: string,
  as: string,
  link?: HTMLLinkElement
): Promise<any> {
  return new Promise<void>((res, rej) => {
    const selector = `
      link[rel="prefetch"][href^="${href}"],
      link[rel="preload"][href^="${href}"],
      script[src^="${href}"]`
    if (document.querySelector(selector)) {
      return res()
    }

    link = document.createElement('link')

    // The order of property assignment here is intentional:
    if (as) link!.as = as
    link!.rel = `prefetch`
    link!.crossOrigin = process.env.__NEXT_CROSS_ORIGIN!
    link!.onload = res as any
    link!.onerror = rej

    // `href` should always be last:
    link!.href = href

    document.head.appendChild(link)
  })
}

const ASSET_LOAD_ERROR = Symbol('ASSET_LOAD_ERROR')
// TODO: unexport
export function markAssetError(err: Error): Error {
  return Object.defineProperty(err, ASSET_LOAD_ERROR, {})
}

export function isAssetError(err?: Error): boolean | undefined {
  return err && ASSET_LOAD_ERROR in err
}

function appendScript(
  src: TrustedScriptURL | string,
  script?: HTMLScriptElement
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    script = document.createElement('script')

    // The order of property assignment here is intentional.
    // 1. Setup success/failure hooks in case the browser synchronously
    //    executes when `src` is set.
    script.onload = resolve
    script.onerror = () =>
      reject(markAssetError(new Error(`Failed to load script: ${src}`)))

    // 2. Configure the cross-origin attribute before setting `src` in case the
    //    browser begins to fetch.
    script.crossOrigin = process.env.__NEXT_CROSS_ORIGIN!

    // 3. Finally, set the source and inject into the DOM in case the child
    //    must be appended for fetching to start.
    script.src = src as string
    document.body.appendChild(script)
  })
}

// We wait for pages to be built in dev before we start the route transition
// timeout to prevent an un-necessary hard navigation in development.
let devBuildPromise: Promise<void> | undefined

// Resolve a promise that times out after given amount of milliseconds.
function resolvePromiseWithTimeout<T>(
  p: Promise<T>,
  ms: number,
  err: Error
): Promise<T> {
  return new Promise((resolve, reject) => {
    let cancelled = false

    p.then((r) => {
      // Resolved, cancel the timeout
      cancelled = true
      resolve(r)
    }).catch(reject)

    // We wrap these checks separately for better dead-code elimination in
    // production bundles.
    if (process.env.NODE_ENV === 'development') {
      ;(devBuildPromise || Promise.resolve()).then(() => {
        requestIdleCallback(() =>
          setTimeout(() => {
            if (!cancelled) {
              reject(err)
            }
          }, ms)
        )
      })
    }

    // ***
    // bug出现的场景只在生产环境下，这里就是问题分场景才出现的原因所在
    // ******

    if (process.env.NODE_ENV !== 'development') {
      requestIdleCallback(() =>
        setTimeout(() => {
          if (!cancelled) {
            reject(err)
          }
        }, ms) // 3800ms之后如果没有被取消掉，那么直接reject
      )
    }
  })
}

// TODO: stop exporting or cache the failure
// It'd be best to stop exporting this. It's an implementation detail. We're
// only exporting it for backwards compatibility with the `page-loader`.
// Only cache this response as a last resort if we cannot eliminate all other
// code branches that use the Build Manifest Callback and push them through
// the Route Loader interface.
export function getClientBuildManifest() { // 获取客户端构建清单
  if (self.__BUILD_MANIFEST) { // 如果直接有了，那么直接返回
    return Promise.resolve(self.__BUILD_MANIFEST)
  }

  const onBuildManifest = new Promise<Record<string, string[]>>((resolve) => {
    // Mandatory because this is not concurrent safe:
    const cb = self.__BUILD_MANIFEST_CB
    self.__BUILD_MANIFEST_CB = () => {
      resolve(self.__BUILD_MANIFEST!) // resolve
      cb && cb()
    } // 在客户端构建清单里面的代码和这里的代码是在互相打配合
    // ******
  })

  /**
   * 
   * 这是在响应回来的html里面的script标签中的链接
   * https://nextjs-hwpjy6--3000.local.webcontainer.io/_next/static/development/_buildManifest.js?ts=1666175496650
   * 
   * 下面就是响应的内容
   * self.__BUILD_MANIFEST = {
    __rewrites: {
        beforeFiles: [],
        afterFiles: [],
        fallback: []
    },
    "/": ["static\u002Fchunks\u002Fpages\u002Findex.js"],
    "/_error": ["static\u002Fchunks\u002Fpages\u002F_error.js"],
    sortedPages: ["\u002F", "\u002F_app", "\u002F_error"]
};
self.__BUILD_MANIFEST_CB && self.__BUILD_MANIFEST_CB()

注意：这个构建后的清单文件是在prepare阶段，也就是通过webpack打包生成的
// 它对应着webpack配置中的plugin
// 也就是在webpack-config.ts中引入的BuildManifestPlugin

// 这个插件是在next/build/webpack/plugins/build-manifest-plugin.ts下

   * 
   */

  return resolvePromiseWithTimeout(
    onBuildManifest,
    MS_MAX_IDLE_DELAY, // 3800ms
    markAssetError(new Error('Failed to load client build manifest'))
  )
}

interface RouteFiles {
  scripts: (TrustedScriptURL | string)[]
  css: string[]
}
function getFilesForRoute(
  assetPrefix: string,
  route: string
): Promise<RouteFiles> {
  if (process.env.NODE_ENV === 'development') {
    const scriptUrl =
      assetPrefix +
      '/_next/static/chunks/pages' +
      encodeURI(getAssetPathFromRoute(route, '.js'))
    return Promise.resolve({
      scripts: [__unsafeCreateTrustedScriptURL(scriptUrl)],
      // Styles are handled by `style-loader` in development:
      css: [],
    })
  }
  return getClientBuildManifest().then((manifest) => {
    if (!(route in manifest)) {
      throw markAssetError(new Error(`Failed to lookup route: ${route}`))
    }
    const allFiles = manifest[route].map(
      (entry) => assetPrefix + '/_next/' + encodeURI(entry)
    )
    return {
      scripts: allFiles
        .filter((v) => v.endsWith('.js'))
        .map((v) => __unsafeCreateTrustedScriptURL(v)),
      css: allFiles.filter((v) => v.endsWith('.css')),
    }
  })
}

export function createRouteLoader(assetPrefix: string): RouteLoader {
  const entrypoints: Map<string, Future<RouteEntrypoint> | RouteEntrypoint> =
    new Map()
  const loadedScripts: Map<string, Promise<unknown>> = new Map()
  const styleSheets: Map<string, Promise<RouteStyleSheet>> = new Map()
  const routes: Map<string, Future<RouteLoaderEntry> | RouteLoaderEntry> =
    new Map()

  function maybeExecuteScript(
    src: TrustedScriptURL | string
  ): Promise<unknown> {
    // With HMR we might need to "reload" scripts when they are
    // disposed and readded. Executing scripts twice has no functional
    // differences
    if (process.env.NODE_ENV !== 'development') {
      let prom: Promise<unknown> | undefined = loadedScripts.get(src.toString())
      if (prom) {
        return prom
      }

      // Skip executing script if it's already in the DOM:
      if (document.querySelector(`script[src^="${src}"]`)) {
        return Promise.resolve()
      }

      loadedScripts.set(src.toString(), (prom = appendScript(src)))
      return prom
    } else {
      return appendScript(src)
    }
  }

  function fetchStyleSheet(href: string): Promise<RouteStyleSheet> {
    let prom: Promise<RouteStyleSheet> | undefined = styleSheets.get(href)
    if (prom) {
      return prom
    }

    styleSheets.set(
      href,
      (prom = fetch(href)
        .then((res) => {
          if (!res.ok) {
            throw new Error(`Failed to load stylesheet: ${href}`)
          }
          return res.text().then((text) => ({ href: href, content: text }))
        })
        .catch((err) => {
          throw markAssetError(err)
        }))
    )
    return prom
  }

  return {
    // ***当入口点注册成功的时候
    whenEntrypoint(route: string) {
      return withFuture(route, entrypoints) // ***
    },
    // ***响应入口点
    onEntrypoint(route: string, execute: undefined | (() => unknown)) {
      ;(execute
        ? Promise.resolve()
            .then(() => execute()) // ***
            .then(
              (exports: any) => ({
                component: (exports && exports.default) || exports, // ***
                exports: exports, // ***
              }),
              (err) => ({ error: err })
            )
        : Promise.resolve(undefined)
      ).then((input: RouteEntrypoint | undefined) => {
        const old = entrypoints.get(route)
        if (old && 'resolve' in old) {
          if (input) {
            entrypoints.set(route, input) // ***
            old.resolve(input) // ***
          }
        } else {
          if (input) {
            entrypoints.set(route, input)
          } else {
            entrypoints.delete(route)
          }
          // when this entrypoint has been resolved before
          // the route is outdated and we want to invalidate
          // this cache entry
          routes.delete(route)
        }
      })
    },
    loadRoute(route: string, prefetch?: boolean) {
      return withFuture<RouteLoaderEntry>(route, routes, () => {
        let devBuildPromiseResolve: () => void

        if (process.env.NODE_ENV === 'development') {
          devBuildPromise = new Promise<void>((resolve) => {
            devBuildPromiseResolve = resolve
          })
        }

        return resolvePromiseWithTimeout(
          getFilesForRoute(assetPrefix, route)
            .then(({ scripts, css }) => {
              return Promise.all([
                entrypoints.has(route)
                  ? []
                  : Promise.all(scripts.map(maybeExecuteScript)),
                Promise.all(css.map(fetchStyleSheet)),
              ] as const)
            })
            .then((res) => {
              return this.whenEntrypoint(route).then((entrypoint) => ({
                entrypoint,
                styles: res[1],
              }))
            }),
          MS_MAX_IDLE_DELAY,
          markAssetError(new Error(`Route did not complete loading: ${route}`))
        )
          .then(({ entrypoint, styles }) => {
            const res: RouteLoaderEntry = Object.assign<
              { styles: RouteStyleSheet[] },
              RouteEntrypoint
            >({ styles: styles! }, entrypoint)
            return 'error' in entrypoint ? entrypoint : res
          })
          .catch((err) => {
            if (prefetch) {
              // we don't want to cache errors during prefetch
              throw err
            }
            return { error: err }
          })
          .finally(() => devBuildPromiseResolve?.())
      })
    },
    prefetch(route: string): Promise<void> {
      // https://github.com/GoogleChromeLabs/quicklink/blob/453a661fa1fa940e2d2e044452398e38c67a98fb/src/index.mjs#L115-L118
      // License: Apache 2.0
      let cn
      if ((cn = (navigator as any).connection)) {
        // Don't prefetch if using 2G or if Save-Data is enabled.
        if (cn.saveData || /2g/.test(cn.effectiveType)) return Promise.resolve()
      }
      return getFilesForRoute(assetPrefix, route)
        .then((output) =>
          Promise.all(
            canPrefetch
              ? output.scripts.map((script) =>
                  prefetchViaDom(script.toString(), 'script')
                )
              : []
          )
        )
        .then(() => {
          requestIdleCallback(() => this.loadRoute(route, true).catch(() => {}))
        })
        .catch(
          // swallow prefetch errors
          () => {}
        )
    },
  }
}
