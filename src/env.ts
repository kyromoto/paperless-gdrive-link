import { z } from "zod"

export const CONFIG_PATH = z.string().parse(process.env.CONFIG_PATH)

export const NODE_ENV = z.enum(["development", "production"]).default("development").parse(process.env.NODE_ENV) 
export const LOG_LEVEL = z.enum(["trace", "debug", "info", "error", "fatal", "warning"]).default("info").parse(process.env.LOG_LEVEL)