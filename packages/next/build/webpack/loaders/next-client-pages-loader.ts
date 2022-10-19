import { stringifyRequest } from '../stringify-request'

export type ClientPagesLoaderOptions = {
  absolutePagePath: string
  page: string
}

// ***
// 当前loader是用来去处理next-client-pages-loader?absolutePagePath=%2Fhome%2Fprojects%2Fnextjs-hwpjy6%2Fpages%2Findex.js&page=%2F!这样的url的
// ***
// this parameter: https://www.typescriptlang.org/docs/handbook/functions.html#this-parameters
function nextClientPagesLoader(this: any) {
  const pagesLoaderSpan = this.currentTraceSpan.traceChild(
    'next-client-pages-loader'
  )

  return pagesLoaderSpan.traceFn(() => {
    // ***
    const { absolutePagePath, page } = // ***取出url拼接中的两个query参数***
      this.getOptions() as ClientPagesLoaderOptions

    pagesLoaderSpan.setAttribute('absolutePagePath', absolutePagePath)

    // ***
    const stringifiedPageRequest = stringifyRequest(this, absolutePagePath) // 取出url中绝对路径参数，然后下面做一个字符串js的拼接
    // 其中最为重要的就是使用require函数去引入加载这个绝对路径请求的啦 ~
    // 例如：工程目录/pages/index.js就会出现在下面的require函数之中
    // ***
    const stringifiedPage = JSON.stringify(page)

    // window.__NEXT_P是一个数组
    // 它的push函数被改写成register函数啦 ~
    return `
    (window.__NEXT_P = window.__NEXT_P || []).push([
      ${stringifiedPage},
      function () {
        return require(${stringifiedPageRequest});
      }
    ]);
    if(module.hot) {
      module.hot.dispose(function () {
        window.__NEXT_P.push([${stringifiedPage}])
      });
    }
  `
  })
}

export default nextClientPagesLoader
