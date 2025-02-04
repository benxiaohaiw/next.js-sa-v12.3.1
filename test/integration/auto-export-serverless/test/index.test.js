/* eslint-env jest */

import webdriver from 'next-webdriver'
import path from 'path'
import { nextBuild, nextStart, findPort, killApp } from 'next-test-utils'

const appDir = path.join(__dirname, '..')
let appPort
let app

describe.skip('Auto Export Serverless', () => {
  it('Refreshes query on mount', async () => {
    await nextBuild(appDir)
    appPort = await findPort()
    app = await nextStart(appDir, appPort)

    const browser = await webdriver(appPort, '/post-1')
    const html = await browser.eval('document.body.innerHTML')
    expect(html).toMatch(/post.*post-1/)
    expect(html).toMatch(/nextExport/)

    await killApp(app)
    await browser.close()
  })
})
