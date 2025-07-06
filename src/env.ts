import { z } from "zod"

export const NODE_ENV = z.enum(["development", "production"]).default("development").parse(process.env.NODE_ENV) 
export const CONFIG_PATH = z.string().parse(process.env.CONFIG_PATH)
export const PORT = z.number().min(1024).default(3000).parse(Number(process.env.PORT))
export const DATA_PATH = z.string().parse(process.env.DATA_PATH)
export const WEBHOOK_URL = z.string().url().parse(process.env.WEBHOOK_URL)
export const LOG_LEVEL = z.enum(["trace", "debug", "info", "warning", "error", "fatal"]).default("info").parse(process.env.LOG_LEVEL)
export const CONCURRENCY = z.number().min(1).default(1).parse(Number(process.env.CONCURRENCY))