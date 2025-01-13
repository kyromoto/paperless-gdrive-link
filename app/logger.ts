const format = (level: string, message: string, ...args: unknown[]) => {
    const ts = new Date().toISOString()
    const fargs = args.length ? `${args.join(" ")}` : ""
    return `[${ts}] ${level.padEnd(5)} : ${message} ${fargs}`
}

const debug = (message: string, ...args: unknown[]) => {
    console.debug(format("DEBUG", message, ...args))
}

const info = (message: string, ...args: unknown[]) => {
    console.info(format("INFO", message, ...args))
}

const warn = (message: string, ...args: unknown[]) => {
    console.warn(format("WARN", message, ...args))
}

const error = (message: string, ...args: unknown[]) => {
    console.error(format("ERROR", message, ...args))
}

export { debug, info, warn, error }