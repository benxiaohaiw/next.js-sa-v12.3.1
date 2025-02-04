export type cliCommand = (argv?: string[]) => void

export const commands: { [command: string]: () => Promise<cliCommand> } = {
  build: () => Promise.resolve(require('../cli/next-build').nextBuild),
  start: () => Promise.resolve(require('../cli/next-start').nextStart),
  export: () => Promise.resolve(require('../cli/next-export').nextExport),
  dev: () => Promise.resolve(require('../cli/next-dev').nextDev), // cli/next-dev
  lint: () => Promise.resolve(require('../cli/next-lint').nextLint),
  telemetry: () =>
    Promise.resolve(require('../cli/next-telemetry').nextTelemetry),
  info: () => Promise.resolve(require('../cli/next-info').nextInfo),
}
