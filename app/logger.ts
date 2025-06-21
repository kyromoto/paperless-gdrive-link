import { ConsoleLogger, Log, Severity } from "@cross/log"
// import { Severity } from "https://jsr.io/@cross/log/0.10.5/src/types.ts";


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