import { ConsoleLogger, Log } from "@cross/log"
import { Severity } from "https://jsr.io/@cross/log/0.10.5/src/types.ts";


// const format = (level: string, message: string, ...args: unknown[]) => {
//     const ts = new Date().toISOString()
//     const fargs = args.length ? `${args.join(" ")}` : ""
//     return `[${ts}] ${level.padEnd(5)} : ${message} ${fargs}`
// }

// const debug = (message: string, ...args: unknown[]) => {
//     console.debug(format("DEBUG", message, ...args))
// }

// const info = (message: string, ...args: unknown[]) => {
//     console.info(format("INFO", message, ...args))
// }

// const warn = (message: string, ...args: unknown[]) => {
//     console.warn(format("WARN", message, ...args))
// }

// const error = (message: string, ...args: unknown[]) => {
//     console.error(format("ERROR", message, ...args))
// }

// export { debug, info, warn, error }


const logLevel = () => {

    const level = Deno.env.get("LOG_LEVEL")?.toUpperCase() || "INFO"

    switch (level) {
        case "DEBUG":
            return Severity.Debug
        case "INFO":
            return Severity.Info
        case "WARN":
            return Severity.Warn
        case "ERROR":
            return Severity.Error
        default:
            throw new Error(`Unknown log level ${level}`)
    }

}



export const log = new Log([
    new ConsoleLogger({
        minimumSeverity: logLevel()
    })
])