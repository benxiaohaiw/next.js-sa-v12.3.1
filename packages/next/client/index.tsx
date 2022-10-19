/* global location */
import '../build/polyfills/polyfill-module'
import React from 'react'
import { HeadManagerContext } from '../shared/lib/head-manager-context'
import mitt, { MittEmitter } from '../shared/lib/mitt'
import { RouterContext } from '../shared/lib/router-context'
import type Router from '../shared/lib/router/router'
import {
  AppComponent,
  AppProps,
  PrivateRouteInfo,
} from '../shared/lib/router/router'
import { isDynamicRoute } from '../shared/lib/router/utils/is-dynamic'
import {
  urlQueryToSearchParams,
  assign,
} from '../shared/lib/router/utils/querystring'
import { setConfig } from '../shared/lib/runtime-config'
import {
  getURL,
  loadGetInitialProps,
  NextWebVitalsMetric,
  NEXT_DATA,
  ST,
} from '../shared/lib/utils'
import { Portal } from './portal'
import initHeadManager from './head-manager'
import PageLoader, { StyleSheetTuple } from './page-loader'
import measureWebVitals from './performance-relayer'
import { RouteAnnouncer } from './route-announcer'
import { createRouter, makePublicRouterInstance } from './router'
import { getProperError } from '../lib/is-error'
import { ImageConfigContext } from '../shared/lib/image-config-context'
import { ImageConfigComplete } from '../shared/lib/image-config'
import { removeBasePath } from './remove-base-path'
import { hasBasePath } from './has-base-path'

const ReactDOM = process.env.__NEXT_REACT_ROOT
  ? require('react-dom/client')
  : require('react-dom')

/// <reference types="react-dom/experimental" />

declare let __webpack_public_path__: string

declare global {
  interface Window {
    /* test fns */
    __NEXT_HYDRATED?: boolean
    __NEXT_HYDRATED_CB?: () => void

    /* prod */
    __NEXT_PRELOADREADY?: (ids?: (string | number)[]) => void
    __NEXT_DATA__: NEXT_DATA
    __NEXT_P: any[]
  }
}

type RenderRouteInfo = PrivateRouteInfo & {
  App: AppComponent
  scroll?: { x: number; y: number } | null
}
type RenderErrorProps = Omit<RenderRouteInfo, 'Component' | 'styleSheets'>
type RegisterFn = (input: [string, () => void]) => void

export const version = process.env.__NEXT_VERSION
export let router: Router
export const emitter: MittEmitter<string> = mitt()

const looseToArray = <T extends {}>(input: any): T[] => [].slice.call(input)

let initialData: NEXT_DATA
let defaultLocale: string | undefined = undefined
let asPath: string
let pageLoader: PageLoader
let appElement: HTMLElement | null
let headManager: {
  mountedInstances: Set<unknown>
  updateHead: (head: JSX.Element[]) => void
  getIsSsr?: () => boolean
}
let initialMatchesMiddleware = false
let lastAppProps: AppProps

let lastRenderReject: (() => void) | null
let webpackHMR: any

let CachedApp: AppComponent, onPerfEntry: (metric: any) => void
let CachedComponent: React.ComponentType

  // Ignore the module ID transform in client.
  // @ts-ignore
;(self as any).__next_require__ = __webpack_require__

// Container组件
class Container extends React.Component<{
  fn: (err: Error, info?: any) => void
}> {
  componentDidCatch(componentErr: Error, info: any) {
    this.props.fn(componentErr, info)
  }

  // ******
  // 组件已挂载钩子函数
  componentDidMount() {
    this.scrollToHash()

    // We need to replace the router state if:
    // - the page was (auto) exported and has a query string or search (hash)
    // - it was auto exported and is a dynamic route (to provide params)
    // - if it is a client-side skeleton (fallback render)
    // - if middleware matches the current page (may have rewrite params)
    // - if rewrites in next.config.js match (may have rewrite params)
    if (
      // 假设我们现在访问的是 /
      /**
       * 页面中的__NEXT_DATA__
       * {"props":{"pageProps":{}},"page":"/","query":{},"buildId":"development","nextExport":true,"autoExport":true,"isFallback":false,"scriptLoader":[]}
       * 
       */
      router.isSsr && // true
      // We don't update for 404 requests as this can modify
      // the asPath unexpectedly e.g. adding basePath when
      // it wasn't originally present
      initialData.page !== '/404' && // true
      initialData.page !== '/_error' && // true
      (initialData.isFallback || // false
        (initialData.nextExport && // 由上面得知为true
          // /\/\[[^/]+?\](?=\/|$)/.test(router.pathname)
          (isDynamicRoute(router.pathname) || // false
            location.search || // '' -> false
            process.env.__NEXT_HAS_REWRITES ||
            initialMatchesMiddleware)) || // false
        (initialData.props && // true
          initialData.props.__N_SSG && // false
          (location.search || // '' -> false
            process.env.__NEXT_HAS_REWRITES ||
            initialMatchesMiddleware))) // false
    ) {
      // 举例：在https://www.yuque.com/lanbitouw/povrtq/gied92#J5Jra
      // 中的这个bug问题在这里来看，上面的判断对应location.search是有值的，所以整体为true
      // 所以就需要在挂载期间为这个已导出的页面更新query，也就是location.search属性
      // 就是?xxx=xxx这个东东

      // ***
      // 为已导出的页面在挂载期间更新query
      // ***
      // update query on mount for exported pages
      router
        .replace(
          // 就拿上面那个bug举例比如/?foo=foo&bar=bar
          // ok啦在这里在组件挂载之后执行了router.replace函数（准确的来说有query的出现那么就会执行这里的replace逻辑）
          // 具体详细逻辑在next/shared/lib/router/router.ts中，可以查看
          router.pathname + // /
            '?' + // ?
            String(
              assign(
                urlQueryToSearchParams(router.query), // 
                new URLSearchParams(location.search) // 
              )
            ), // /?foo=foo&bar=bar
          asPath,
          {
            // @ts-ignore
            // WARNING: `_h` is an internal option for handing Next.js
            // client-side hydration. Your app should _never_ use this property.
            // It may change at any time without notice.
            _h: 1,
            // Fallback pages must trigger the data fetch, so the transition is
            // not shallow.
            // Other pages (strictly updating query) happens shallowly, as data
            // requirements would already be present.
            shallow: !initialData.isFallback && !initialMatchesMiddleware,
          }
        )
        .catch((err) => {
          if (!err.cancelled) throw err
        })
    }
  }

  componentDidUpdate() {
    this.scrollToHash()
  }

  scrollToHash() {
    let { hash } = location
    hash = hash && hash.substring(1)
    if (!hash) return

    const el: HTMLElement | null = document.getElementById(hash)
    if (!el) return

    // If we call scrollIntoView() in here without a setTimeout
    // it won't scroll properly.
    setTimeout(() => el.scrollIntoView(), 0)
  }

  // 容器组件渲染函数
  render() {
    if (process.env.NODE_ENV === 'production') {
      return this.props.children // 生产模式下直接返回children
    } else {
      const {
        ReactDevOverlay,
      } = require('next/dist/compiled/@next/react-dev-overlay/dist/client')
      return <ReactDevOverlay>{this.props.children}</ReactDevOverlay>
      // 开发模式下通过ReactDevOverlay组件包裹一下啦 ~
    }
  }
}


// 1
// ***
// 先执行初始化逻辑的操作
export async function initialize(opts: { webpackHMR?: any } = {}): Promise<{
  assetPrefix: string
}> {
  // This makes sure this specific lines are removed in production
  if (process.env.NODE_ENV === 'development') {
    webpackHMR = opts.webpackHMR
  }

  // 初始化数据就是随html字符串带过来的__NEXT_DATA__中的内容一个json字符串，然后转为对象
  initialData = JSON.parse(
    document.getElementById('__NEXT_DATA__')!.textContent!
  )

  window.__NEXT_DATA__ = initialData // 挂在window上

  defaultLocale = initialData.defaultLocale
  const prefix: string = initialData.assetPrefix || ''
  // With dynamic assetPrefix it's no longer possible to set assetPrefix at the build time
  // So, this is how we do it in the client side at runtime
  __webpack_public_path__ = `${prefix}/_next/` //eslint-disable-line

  // Initialize next/config with the environment configuration
  setConfig({
    serverRuntimeConfig: {},
    publicRuntimeConfig: initialData.runtimeConfig || {},
  })

  asPath = getURL()

  // make sure not to attempt stripping basePath for 404s
  if (hasBasePath(asPath)) {
    asPath = removeBasePath(asPath)
  }

  if (process.env.__NEXT_I18N_SUPPORT) {
    const { normalizeLocalePath } =
      require('../shared/lib/i18n/normalize-locale-path') as typeof import('../shared/lib/i18n/normalize-locale-path')

    const { detectDomainLocale } =
      require('../shared/lib/i18n/detect-domain-locale') as typeof import('../shared/lib/i18n/detect-domain-locale')

    const { parseRelativeUrl } =
      require('../shared/lib/router/utils/parse-relative-url') as typeof import('../shared/lib/router/utils/parse-relative-url')

    const { formatUrl } =
      require('../shared/lib/router/utils/format-url') as typeof import('../shared/lib/router/utils/format-url')

    if (initialData.locales) {
      const parsedAs = parseRelativeUrl(asPath)
      const localePathResult = normalizeLocalePath(
        parsedAs.pathname,
        initialData.locales
      )

      if (localePathResult.detectedLocale) {
        parsedAs.pathname = localePathResult.pathname
        asPath = formatUrl(parsedAs)
      } else {
        // derive the default locale if it wasn't detected in the asPath
        // since we don't prerender static pages with all possible default
        // locales
        defaultLocale = initialData.locale
      }

      // attempt detecting default locale based on hostname
      const detectedDomain = detectDomainLocale(
        process.env.__NEXT_I18N_DOMAINS as any,
        window.location.hostname
      )

      // TODO: investigate if defaultLocale needs to be populated after
      // hydration to prevent mismatched renders
      if (detectedDomain) {
        defaultLocale = detectedDomain.defaultLocale
      }
    }
  }

  if (initialData.scriptLoader) {
    const { initScriptLoader } = require('./script')
    initScriptLoader(initialData.scriptLoader)
  }

  // 创建一个页面加载者实例对象
  pageLoader = new PageLoader(initialData.buildId, prefix)

  // 注册
  const register: RegisterFn = ([r, f]) =>
    pageLoader.routeLoader.onEntrypoint(r, f) // 响应入口点
  // ***
  if (window.__NEXT_P) {
    // Defer page registration for another tick. This will increase the overall
    // latency in hydrating the page, but reduce the total blocking time.
    window.__NEXT_P.map((p) => setTimeout(() => register(p), 0)) // ***延时注册***
  }
  window.__NEXT_P = []
  ;(window.__NEXT_P as any).push = register // 

  headManager = initHeadManager()
  headManager.getIsSsr = () => {
    return router.isSsr
  }

  // 获取id为__next的div元素，它是整个应用的根节点
  appElement = document.getElementById('__next')
  return { assetPrefix: prefix }
}

// 这个函数就是返回<App {...appProps} />
function renderApp(App: AppComponent, appProps: AppProps) {
  return <App {...appProps} />
}

function AppContainer({
  children,
}: React.PropsWithChildren<{}>): React.ReactElement {
  return ( // 使用到了Container组件
    <Container
      fn={(error) =>
        // TODO: Fix disabled eslint rule
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        renderError({ App: CachedApp, err: error }).catch((err) =>
          console.error('Error rendering page: ', err)
        )
      }
    >
      <RouterContext.Provider value={makePublicRouterInstance(router)}>
        <HeadManagerContext.Provider value={headManager}>
          <ImageConfigContext.Provider
            value={process.env.__NEXT_IMAGE_OPTS as any as ImageConfigComplete}
          >
            {children/** 在这里放置了children属性 */}
          </ImageConfigContext.Provider>
        </HeadManagerContext.Provider>
      </RouterContext.Provider>
    </Container>
  )
}

const wrapApp =
  (App: AppComponent) =>
  (wrappedAppProps: Record<string, any>): JSX.Element => {
    const appProps: AppProps = {
      ...wrappedAppProps,
      Component: CachedComponent,
      err: initialData.err,
      router,
    }
    return <AppContainer>{renderApp(App, appProps)}</AppContainer>
  }

// This method handles all runtime and debug errors.
// 404 and 500 errors are special kind of errors
// and they are still handle via the main render method.
function renderError(renderErrorProps: RenderErrorProps): Promise<any> {
  let { App, err } = renderErrorProps

  // In development runtime errors are caught by our overlay
  // In production we catch runtime errors using componentDidCatch which will trigger renderError
  if (process.env.NODE_ENV !== 'production') {
    // A Next.js rendering runtime error is always unrecoverable
    // FIXME: let's make this recoverable (error in GIP client-transition)
    webpackHMR.onUnrecoverableError()

    // We need to render an empty <App> so that the `<ReactDevOverlay>` can
    // render itself.
    // TODO: Fix disabled eslint rule
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    return doRender({
      App: () => null,
      props: {},
      Component: () => null,
      styleSheets: [],
    })
  }

  // Make sure we log the error to the console, otherwise users can't track down issues.
  console.error(err)
  console.error(
    `A client-side exception has occurred, see here for more info: https://nextjs.org/docs/messages/client-side-exception-occurred`
  )

  return pageLoader
    .loadPage('/_error')
    .then(({ page: ErrorComponent, styleSheets }) => {
      return lastAppProps?.Component === ErrorComponent
        ? import('../pages/_error')
            .then((errorModule) => {
              return import('../pages/_app').then((appModule) => {
                App = appModule.default as any as AppComponent
                renderErrorProps.App = App
                return errorModule
              })
            })
            .then((m) => ({
              ErrorComponent: m.default as React.ComponentType<{}>,
              styleSheets: [],
            }))
        : { ErrorComponent, styleSheets }
    })
    .then(({ ErrorComponent, styleSheets }) => {
      // In production we do a normal render with the `ErrorComponent` as component.
      // If we've gotten here upon initial render, we can use the props from the server.
      // Otherwise, we need to call `getInitialProps` on `App` before mounting.
      const AppTree = wrapApp(App)
      const appCtx = {
        Component: ErrorComponent,
        AppTree,
        router,
        ctx: {
          err,
          pathname: initialData.page,
          query: initialData.query,
          asPath,
          AppTree,
        },
      }
      return Promise.resolve(
        renderErrorProps.props?.err
          ? renderErrorProps.props
          : loadGetInitialProps(App, appCtx)
      ).then((initProps) =>
        // TODO: Fix disabled eslint rule
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        doRender({
          ...renderErrorProps,
          err,
          Component: ErrorComponent,
          styleSheets,
          props: initProps,
        })
      )
    })
}

// Dummy component that we render as a child of Root so that we can
// toggle the correct styles before the page is rendered.
function Head({ callback }: { callback: () => void }): null {
  // We use `useLayoutEffect` to guarantee the callback is executed
  // as soon as React flushes the update.
  React.useLayoutEffect(() => callback(), [callback])
  return null
}

let reactRoot: any = null
// On initial render a hydrate should always happen
let shouldHydrate: boolean = true

function clearMarks(): void {
  ;['beforeRender', 'afterHydrate', 'afterRender', 'routeChange'].forEach(
    (mark) => performance.clearMarks(mark)
  )
}

function markHydrateComplete(): void {
  if (!ST) return

  performance.mark('afterHydrate') // mark end of hydration

  performance.measure(
    'Next.js-before-hydration',
    'navigationStart',
    'beforeRender'
  )
  performance.measure('Next.js-hydration', 'beforeRender', 'afterHydrate')

  if (onPerfEntry) {
    performance.getEntriesByName('Next.js-hydration').forEach(onPerfEntry)
  }
  clearMarks()
}

function markRenderComplete(): void {
  if (!ST) return

  performance.mark('afterRender') // mark end of render
  const navStartEntries: PerformanceEntryList = performance.getEntriesByName(
    'routeChange',
    'mark'
  )

  if (!navStartEntries.length) return

  performance.measure(
    'Next.js-route-change-to-render',
    navStartEntries[0].name,
    'beforeRender'
  )
  performance.measure('Next.js-render', 'beforeRender', 'afterRender')
  if (onPerfEntry) {
    performance.getEntriesByName('Next.js-render').forEach(onPerfEntry)
    performance
      .getEntriesByName('Next.js-route-change-to-render')
      .forEach(onPerfEntry)
  }

  clearMarks()
  ;['Next.js-route-change-to-render', 'Next.js-render'].forEach((measure) =>
    performance.clearMeasures(measure)
  )
}

function renderReactElement(
  domEl: HTMLElement,
  fn: (cb: () => void) => JSX.Element
): void {
  // mark start of hydrate/render
  if (ST) {
    performance.mark('beforeRender')
  }

  const reactEl = fn(shouldHydrate ? markHydrateComplete : markRenderComplete)
  if (process.env.__NEXT_REACT_ROOT) {
    if (!reactRoot) {
      // Unlike with createRoot, you don't need a separate root.render() call here
      reactRoot = ReactDOM.hydrateRoot(domEl, reactEl)
      // TODO: Remove shouldHydrate variable when React 18 is stable as it can depend on `reactRoot` existing
      shouldHydrate = false
    } else {
      const startTransition = (React as any).startTransition
      startTransition(() => {
        reactRoot.render(reactEl)
      })
    }
  } else {
    // The check for `.hydrate` is there to support React alternatives like preact
    if (shouldHydrate) {
      ReactDOM.hydrate(reactEl, domEl)
      shouldHydrate = false
    } else {
      ReactDOM.render(reactEl, domEl)
    }
  }
}

function Root({
  callbacks,
  children,
}: React.PropsWithChildren<{
  callbacks: Array<() => void>
}>): React.ReactElement {
  // We use `useLayoutEffect` to guarantee the callbacks are executed
  // as soon as React flushes the update
  React.useLayoutEffect(
    () => callbacks.forEach((callback) => callback()),
    [callbacks]
  )
  // We should ask to measure the Web Vitals after rendering completes so we
  // don't cause any hydration delay:
  React.useEffect(() => {
    measureWebVitals(onPerfEntry)
  }, [])

  if (process.env.__NEXT_TEST_MODE) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    React.useEffect(() => {
      window.__NEXT_HYDRATED = true

      if (window.__NEXT_HYDRATED_CB) {
        window.__NEXT_HYDRATED_CB()
      }
    }, [])
  }

  return children as React.ReactElement
}

function doRender(input: RenderRouteInfo): Promise<any> {
  // App组件、/对应的index组件
  let { App, Component, props, err }: RenderRouteInfo = input
  let styleSheets: StyleSheetTuple[] | undefined =
    'initial' in input ? undefined : input.styleSheets
  Component = Component || lastAppProps.Component
  props = props || lastAppProps.props

  // 准备好app属性
  const appProps: AppProps = {
    ...props,
    Component,
    err,
    router,
  }
  // lastAppProps has to be set before ReactDom.render to account for ReactDom throwing an error.
  lastAppProps = appProps

  let canceled: boolean = false
  let resolvePromise: () => void
  const renderPromise = new Promise<void>((resolve, reject) => {
    if (lastRenderReject) {
      lastRenderReject()
    }
    resolvePromise = () => {
      lastRenderReject = null
      resolve()
    }
    lastRenderReject = () => {
      canceled = true
      lastRenderReject = null

      const error: any = new Error('Cancel rendering route')
      error.cancelled = true
      reject(error)
    }
  })

  // This function has a return type to ensure it doesn't start returning a
  // Promise. It should remain synchronous.
  function onStart(): boolean {
    if (
      !styleSheets ||
      // We use `style-loader` in development, so we don't need to do anything
      // unless we're in production:
      process.env.NODE_ENV !== 'production'
    ) {
      return false
    }

    const currentStyleTags: HTMLStyleElement[] = looseToArray<HTMLStyleElement>(
      document.querySelectorAll('style[data-n-href]')
    )
    const currentHrefs: Set<string | null> = new Set(
      currentStyleTags.map((tag) => tag.getAttribute('data-n-href'))
    )

    const noscript: Element | null = document.querySelector(
      'noscript[data-n-css]'
    )
    const nonce: string | null | undefined =
      noscript?.getAttribute('data-n-css')

    styleSheets.forEach(({ href, text }: { href: string; text: any }) => {
      if (!currentHrefs.has(href)) {
        const styleTag = document.createElement('style')
        styleTag.setAttribute('data-n-href', href)
        styleTag.setAttribute('media', 'x')

        if (nonce) {
          styleTag.setAttribute('nonce', nonce)
        }

        document.head.appendChild(styleTag)
        styleTag.appendChild(document.createTextNode(text))
      }
    })
    return true
  }

  function onHeadCommit(): void {
    if (
      // We use `style-loader` in development, so we don't need to do anything
      // unless we're in production:
      process.env.NODE_ENV === 'production' &&
      // We can skip this during hydration. Running it wont cause any harm, but
      // we may as well save the CPU cycles:
      styleSheets &&
      // Ensure this render was not canceled
      !canceled
    ) {
      const desiredHrefs: Set<string> = new Set(styleSheets.map((s) => s.href))
      const currentStyleTags: HTMLStyleElement[] =
        looseToArray<HTMLStyleElement>(
          document.querySelectorAll('style[data-n-href]')
        )
      const currentHrefs: string[] = currentStyleTags.map(
        (tag) => tag.getAttribute('data-n-href')!
      )

      // Toggle `<style>` tags on or off depending on if they're needed:
      for (let idx = 0; idx < currentHrefs.length; ++idx) {
        if (desiredHrefs.has(currentHrefs[idx])) {
          currentStyleTags[idx].removeAttribute('media')
        } else {
          currentStyleTags[idx].setAttribute('media', 'x')
        }
      }

      // Reorder styles into intended order:
      let referenceNode: Element | null = document.querySelector(
        'noscript[data-n-css]'
      )
      if (
        // This should be an invariant:
        referenceNode
      ) {
        styleSheets.forEach(({ href }: { href: string }) => {
          const targetTag: Element | null = document.querySelector(
            `style[data-n-href="${href}"]`
          )
          if (
            // This should be an invariant:
            targetTag
          ) {
            referenceNode!.parentNode!.insertBefore(
              targetTag,
              referenceNode!.nextSibling
            )
            referenceNode = targetTag
          }
        })
      }

      // Finally, clean up server rendered stylesheets:
      looseToArray<HTMLLinkElement>(
        document.querySelectorAll('link[data-n-p]')
      ).forEach((el) => {
        el.parentNode!.removeChild(el)
      })
    }

    if (input.scroll) {
      const htmlElement = document.documentElement
      const existing = htmlElement.style.scrollBehavior
      htmlElement.style.scrollBehavior = 'auto'
      window.scrollTo(input.scroll.x, input.scroll.y)
      htmlElement.style.scrollBehavior = existing
    }
  }

  function onRootCommit(): void {
    resolvePromise()
  }

  onStart()

  // 准备好元素
  const elem: JSX.Element = (
    <>
      <Head callback={onHeadCommit} />
      {/** 那么最重要的就是Container组件中做了什么事情 ~ */}
      <AppContainer>{/** 该组件内使用到了Container组件 */}
        {renderApp(App, appProps)/** 执行renderApp函数，传入App组件以及上方准备好的app属性 */}
        {/** renderApp函数就是返回<App {...appProps} />
         * 这样就能清楚_app.js中能够通过props接收到Component组件的原因啦 - 它就是在这里做的)
         */}
        <Portal type="next-route-announcer">
          <RouteAnnouncer />
        </Portal>
      </AppContainer>
    </>
  )

  // appElement就是在初始化函数中获取的__next节点元素，它是作为根节点的
  // 开始渲染react元素啦 ~
  // We catch runtime errors using componentDidCatch which will trigger renderError
  renderReactElement(appElement!, (callback) => ( // 返回Root组件
    <Root callbacks={[callback, onRootCommit]}>
      {process.env.__NEXT_STRICT_MODE ? (
        <React.StrictMode>{elem}</React.StrictMode>
      ) : (
        elem // 作为children
      )}
    </Root>
  ))
  // 这个函数逻辑就是根据情况选择使用ReactDOM.hydrate、render还是hydrateRoot啦
  // 参数就是这里第二个参数函数执行返回的react ele、要操作的根节点容器

  return renderPromise
}

async function render(renderingProps: RenderRouteInfo): Promise<void> {
  if (renderingProps.err) {
    await renderError(renderingProps)
    return
  }

  try {
    // 做渲染
    await doRender(renderingProps)
  } catch (err) {
    const renderErr = getProperError(err)
    // bubble up cancelation errors
    if ((renderErr as Error & { cancelled?: boolean }).cancelled) {
      throw renderErr
    }

    if (process.env.NODE_ENV === 'development') {
      // Ensure this error is displayed in the overlay in development
      setTimeout(() => {
        throw renderErr
      })
    }
    await renderError({ ...renderingProps, err: renderErr })
  }
}

// 2
// 入口 - 混合函数
export async function hydrate(opts?: { beforeRender?: () => Promise<void> }) {
  let initialErr = initialData.err


//   /***/ "./node_modules/next/dist/build/webpack/loaders/next-client-pages-loader.js?absolutePagePath=%2Fhome%2Fprojects%2Fnextjs-hwpjy6%2Fpages%2Findex.js&page=%2F!":
// /*!*******************************************************************************************************************************************************************!*\
//   !*** ./node_modules/next/dist/build/webpack/loaders/next-client-pages-loader.js?absolutePagePath=%2Fhome%2Fprojects%2Fnextjs-hwpjy6%2Fpages%2Findex.js&page=%2F! ***!
//   \*******************************************************************************************************************************************************************/
// /***/ (function(module, __unused_webpack_exports, __webpack_require__) {

// eval(__webpack_require__.ts("\n    (window.__NEXT_P = window.__NEXT_P || []).push([\n      \"/\",\n      function () {\n        return __webpack_require__(/*! ./pages/index.js */ \"./pages/index.js\");\n      }\n    ]);\n    if(true) {\n      module.hot.dispose(function () {\n        window.__NEXT_P.push([\"/\"])\n      });\n    }\n  //# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiLi9ub2RlX21vZHVsZXMvbmV4dC9kaXN0L2J1aWxkL3dlYnBhY2svbG9hZGVycy9uZXh0LWNsaWVudC1wYWdlcy1sb2FkZXIuanM/YWJzb2x1dGVQYWdlUGF0aD0lMkZob21lJTJGcHJvamVjdHMlMkZuZXh0anMtaHdwank2JTJGcGFnZXMlMkZpbmRleC5qcyZwYWdlPSUyRiEuanMiLCJtYXBwaW5ncyI6IjtBQUNBO0FBQ0E7QUFDQTtBQUNBLGVBQWUsbUJBQU8sQ0FBQywwQ0FBa0I7QUFDekM7QUFDQTtBQUNBLE9BQU8sSUFBVTtBQUNqQixNQUFNLFVBQVU7QUFDaEI7QUFDQSxPQUFPO0FBQ1A7QUFDQSIsInNvdXJjZXMiOlsid2VicGFjazovL19OX0UvPzg4NTgiXSwic291cmNlc0NvbnRlbnQiOlsiXG4gICAgKHdpbmRvdy5fX05FWFRfUCA9IHdpbmRvdy5fX05FWFRfUCB8fCBbXSkucHVzaChbXG4gICAgICBcIi9cIixcbiAgICAgIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgcmV0dXJuIHJlcXVpcmUoXCIuL3BhZ2VzL2luZGV4LmpzXCIpO1xuICAgICAgfVxuICAgIF0pO1xuICAgIGlmKG1vZHVsZS5ob3QpIHtcbiAgICAgIG1vZHVsZS5ob3QuZGlzcG9zZShmdW5jdGlvbiAoKSB7XG4gICAgICAgIHdpbmRvdy5fX05FWFRfUC5wdXNoKFtcIi9cIl0pXG4gICAgICB9KTtcbiAgICB9XG4gICJdLCJuYW1lcyI6W10sInNvdXJjZVJvb3QiOiIifQ==\n//# sourceURL=webpack-internal:///./node_modules/next/dist/build/webpack/loaders/next-client-pages-loader.js?absolutePagePath=%2Fhome%2Fprojects%2Fnextjs-hwpjy6%2Fpages%2Findex.js&page=%2F!\n"));

// /***/ }),


// 已确定是next-client-pages-loader.js这个loader里面加的window.__NEXT_P这个变量
// 它是一个数组，其次它的push方法已被改为上面初始化方法中的register函数
// 这个注册函数就是其实就是把模块导出的内容通过pageLoader.routeLoader的onEntryPoint函数响应出去
// 这样通过routeLoader的whenEntrypoint函数返回的promise就能够resolve，此时就能够收到模块导出的内容啦
// 就是这样一个原理机制

// 和whenEntrypoint、onEntrypoint在打配合

  /**
   * 
   * cat .next/static/chunks/pages/index.js
   * 
   * ...
   * 中间有部分内容就是上面注释那部分
   * ...
   * 
   * 
   */

  try {
    // 通过页面加载者实例对象获取到app入口点
    const appEntrypoint = await pageLoader.routeLoader.whenEntrypoint('/_app')
    if ('error' in appEntrypoint) {
      throw appEntrypoint.error
    }

    // ***
    // exports: { default: xxx, xxx: xxx }
    // ***
    // 从app入口点中拿到默认暴露的app组件，component就是default，exports就是上面的那个exports
    const { component: app, exports: mod } = appEntrypoint
    CachedApp = app as AppComponent // 断言为AppComponent
    if (mod && mod.reportWebVitals) {
      onPerfEntry = ({
        id,
        name,
        startTime,
        value,
        duration,
        entryType,
        entries,
        attribution,
      }: any): void => {
        // Combines timestamp with random number for unique ID
        const uniqueID: string = `${Date.now()}-${
          Math.floor(Math.random() * (9e12 - 1)) + 1e12
        }`
        let perfStartEntry: string | undefined

        if (entries && entries.length) {
          perfStartEntry = entries[0].startTime
        }

        const webVitals: NextWebVitalsMetric = {
          id: id || uniqueID,
          name,
          startTime: startTime || perfStartEntry,
          value: value == null ? duration : value,
          label:
            entryType === 'mark' || entryType === 'measure'
              ? 'custom'
              : 'web-vital',
        }
        if (attribution) {
          webVitals.attribution = attribution
        }
        mod.reportWebVitals(webVitals)
      }
    }

    // 比如/ -> 那么就拿到index入口点
    const pageEntrypoint =
      // The dev server fails to serve script assets when there's a hydration
      // error, so we need to skip waiting for the entrypoint.
      process.env.NODE_ENV === 'development' && initialData.err
        ? { error: initialData.err }
        : await pageLoader.routeLoader.whenEntrypoint(initialData.page)
    if ('error' in pageEntrypoint) {
      throw pageEntrypoint.error
    }

    // 从index入口点内拿到默认暴露的组件
    CachedComponent = pageEntrypoint.component

    if (process.env.NODE_ENV !== 'production') {
      const { isValidElementType } = require('next/dist/compiled/react-is')
      if (!isValidElementType(CachedComponent)) {
        throw new Error(
          `The default export is not a React Component in page: "${initialData.page}"`
        )
      }
    }
  } catch (error) {
    // This catches errors like throwing in the top level of a module
    initialErr = getProperError(error)
  }

  if (process.env.NODE_ENV === 'development') {
    const {
      getServerError,
    } = require('next/dist/compiled/@next/react-dev-overlay/dist/client') // 只在开发环境中引入这个react-dev-overlay依赖
    // Server-side runtime errors need to be re-thrown on the client-side so
    // that the overlay is rendered.
    if (initialErr) {
      if (initialErr === initialData.err) {
        setTimeout(() => {
          let error
          try {
            // Generate a new error object. We `throw` it because some browsers
            // will set the `stack` when thrown, and we want to ensure ours is
            // not overridden when we re-throw it below.
            throw new Error(initialErr!.message)
          } catch (e) {
            error = e as Error
          }

          error.name = initialErr!.name
          error.stack = initialErr!.stack
          throw getServerError(error, initialErr!.source)
        })
      }
      // We replaced the server-side error with a client-side error, and should
      // no longer rewrite the stack trace to a Node error.
      else {
        setTimeout(() => {
          throw initialErr
        })
      }
    }
  }

  if (window.__NEXT_PRELOADREADY) {
    await window.__NEXT_PRELOADREADY(initialData.dynamicIds)
  }

  // 创建前端路由器 - 接管控制浏览器前端路由（那肯定监听popstate事件啦 ~ 等）
  router = createRouter(initialData.page, initialData.query, asPath, {
    initialProps: initialData.props,
    pageLoader,
    App: CachedApp,
    Component: CachedComponent,
    wrapApp,
    err: initialErr,
    isFallback: Boolean(initialData.isFallback),
    // ******
    // subscription函数尤为重要
    subscription: (info, App, scroll) => // 即将到来的路由信息 App组件 即将到来的滚动状态
      // 和初次挂载逻辑是一致的，相同的，只是最后不是混合，而是render
      // 执行render函数 -> doRender -> renderReactElement -> ReactDOM.render
      render(
        Object.assign<
          {},
          Omit<RenderRouteInfo, 'App' | 'scroll'>,
          Pick<RenderRouteInfo, 'App' | 'scroll'>
        >({}, info, {
          App,
          scroll,
        }) as RenderRouteInfo
      ),
    locale: initialData.locale,
    locales: initialData.locales,
    defaultLocale,
    domainLocales: initialData.domainLocales,
    isPreview: initialData.isPreview,
  })

  initialMatchesMiddleware = await router._initialMatchesMiddlewarePromise

  // 准备渲染上下文
  const renderCtx: RenderRouteInfo = {
    App: CachedApp, // _app.js中默认暴露的组件
    initial: true,
    Component: CachedComponent, // index.js中默认暴露的组件 - 假设我们正在访问/，那么/ -> pages/index.js
    props: initialData.props,
    err: initialErr,
  }

  if (opts?.beforeRender) {
    await opts.beforeRender() // 执行在渲染之前函数
  }

  // 开始渲染
  render(renderCtx) // 渲染上下文中已拿到_app.js中默认暴露的组件和index.js中默认暴露的组件
}
