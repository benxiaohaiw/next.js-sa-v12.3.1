import type {
  AppType,
  DocumentType,
  NextComponentType,
} from '../shared/lib/utils'
import type {
  PageConfig,
  GetStaticPaths,
  GetServerSideProps,
  GetStaticProps,
} from 'next/types'
import {
  BUILD_MANIFEST,
  REACT_LOADABLE_MANIFEST,
  FLIGHT_MANIFEST,
} from '../shared/lib/constants'
import { join } from 'path'
import { requirePage } from './require'
import { BuildManifest } from './get-page-files'
import { interopDefault } from '../lib/interop-default'

export type ManifestItem = {
  id: number | string
  files: string[]
}

export type ReactLoadableManifest = { [moduleId: string]: ManifestItem }

export type LoadComponentsReturnType = {
  Component: NextComponentType
  pageConfig: PageConfig
  buildManifest: BuildManifest
  subresourceIntegrityManifest?: Record<string, string>
  reactLoadableManifest: ReactLoadableManifest
  serverComponentManifest?: any
  Document: DocumentType
  App: AppType
  getStaticProps?: GetStaticProps
  getStaticPaths?: GetStaticPaths
  getServerSideProps?: GetServerSideProps
  ComponentMod: any
  isAppPath?: boolean
  pathname: string
}

export async function loadDefaultErrorComponents(distDir: string) {
  const Document = interopDefault(require('next/dist/pages/_document'))
  const AppMod = require('next/dist/pages/_app')
  const App = interopDefault(AppMod)
  const ComponentMod = require('next/dist/pages/_error')
  const Component = interopDefault(ComponentMod)

  return {
    App,
    Document,
    Component,
    pageConfig: {},
    buildManifest: require(join(distDir, `fallback-${BUILD_MANIFEST}`)),
    reactLoadableManifest: {},
    ComponentMod,
    pathname: '/_error',
  }
}

export async function loadComponents({
  distDir,
  pathname,
  serverless,
  hasServerComponents,
  isAppPath,
}: {
  distDir: string
  pathname: string
  serverless: boolean
  hasServerComponents: boolean
  isAppPath: boolean
}): Promise<LoadComponentsReturnType> {
  if (serverless) {
    const ComponentMod = await requirePage(pathname, distDir, serverless)
    if (typeof ComponentMod === 'string') {
      return {
        Component: ComponentMod as any,
        pageConfig: {},
        ComponentMod,
      } as LoadComponentsReturnType
    }

    let {
      default: Component,
      getStaticProps,
      getStaticPaths,
      getServerSideProps,
    } = ComponentMod

    Component = await Component
    getStaticProps = await getStaticProps
    getStaticPaths = await getStaticPaths
    getServerSideProps = await getServerSideProps
    const pageConfig = (await ComponentMod.config) || {}

    return {
      Component,
      pageConfig,
      getStaticProps,
      getStaticPaths,
      getServerSideProps,
      ComponentMod,
    } as LoadComponentsReturnType
  }

  // 文档模块
  let DocumentMod = {}
  // App模块
  let AppMod = {}
  if (!isAppPath) {
    // 使用require函数从dist目录下动态引入加载进来，赋值
    ;[DocumentMod, AppMod] = await Promise.all([
      Promise.resolve().then(() =>
        requirePage('/_document', distDir, serverless, false) // .next/server/pages/_document.js
      ),
      Promise.resolve().then(() =>
        requirePage('/_app', distDir, serverless, false) // .next/server/pages/_app.js
      ),
    ])
  }
  const ComponentMod = await Promise.resolve().then(() =>
    requirePage(pathname, distDir, serverless, isAppPath) // / -> .next/server/pages/index.js
  )

  /**
   * 
   *  ❯ cat .next/build-manifest.json
      {
        "polyfillFiles": [
          "static/chunks/polyfills.js"
        ],
        "devFiles": [
          "static/chunks/react-refresh.js"
        ],
        "ampDevFiles": [
          "static/chunks/webpack.js",
          "static/chunks/amp.js"
        ],
        "lowPriorityFiles": [
          "static/development/_buildManifest.js",
          "static/development/_ssgManifest.js"
        ],
        "rootMainFiles": [],
        "pages": { // 这些是服务端返回html字符串时html中的链接地址的
          "/": [
            "static/chunks/webpack.js",
            "static/chunks/main.js",
            "static/chunks/pages/index.js"
          ],
          "/_app": [
            "static/chunks/webpack.js",
            "static/chunks/main.js",
            "static/chunks/pages/_app.js"
          ],
          "/_error": [
            "static/chunks/webpack.js",
            "static/chunks/main.js",
            "static/chunks/pages/_error.js"
          ]
        },
        "ampFirstPages": []
      }
   * 
   */

  const [buildManifest, reactLoadableManifest, serverComponentManifest] =
    await Promise.all([
      require(join(distDir, BUILD_MANIFEST)), // .next/build-manifest.json
      require(join(distDir, REACT_LOADABLE_MANIFEST)),
      hasServerComponents
        ? require(join(distDir, 'server', FLIGHT_MANIFEST + '.json'))
        : null,
    ])

  const Component = interopDefault(ComponentMod) // ***
  const Document = interopDefault(DocumentMod) // ***
  const App = interopDefault(AppMod) // ***

  // / -> index.ts中所暴露的钩子函数
  const { getServerSideProps, getStaticProps, getStaticPaths } = ComponentMod

  // 返回这些信息
  return {
    App,
    Document,
    Component,
    buildManifest,
    reactLoadableManifest,
    pageConfig: ComponentMod.config || {},
    ComponentMod,
    getServerSideProps,
    getStaticProps,
    getStaticPaths,
    serverComponentManifest,
    isAppPath,
    pathname,
  }
}
