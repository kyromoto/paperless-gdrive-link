import * as path from "@std/path";

import { z } from "zod"
import { google } from "googleapis";
import { JWT } from "google-auth-library";


export type ServerConfig = z.infer<typeof ServerConfig>
export const ServerConfig = z.object({
    port: z.number().min(0),
    public_url: z.string().url(),
    data_path: z.string(),
})


export type ChannelConfig = z.infer<typeof ChannelConfig>
export const ChannelConfig = z.object({
    expirationInSec: z.number().min(60).default(5 * 60),
})


export type AccountConfig = z.infer<typeof AccountConfig>
export const AccountConfig = z.object({
    name: z.string(),
    google_drive: z.object({
        folder_id: z.string(),
        credentials_file: z.string(),
        change_token_file: z.string().default("change-token"),
    }),
    paperless_ngx: z.object({
        server_url: z.string().url(),
        credentials: z.object({
            username: z.string(),
            password: z.string(),
        })
    })
})


export type AppConfig = z.infer<typeof AppConfig>
export const AppConfig = z.object({
    server: ServerConfig,
    channel: ChannelConfig,
    accounts: z.array(AccountConfig).min(1)
})


export type GoogleCredentials = z.infer<typeof GoogleCredentials>
export const GoogleCredentials = z.object({
    client_email: z.string(),
    private_key: z.string(),
}).passthrough()







export class AppConfigRepository {

    private config: AppConfig | null = null
    private lastMtime: Date | null = null

    constructor(private filepath: string) {}


    private hasConfigChanged = async () => {

        if (!this.config) {
            return true
        }

        if (!this.lastMtime) {
            return true
        }

        const fileinfo = await Deno.stat(this.filepath)

        if (!fileinfo.mtime) {
            return true
        }

        return fileinfo.mtime > this.lastMtime

    }



    getConfig = async () => {

        if (!this.config || await this.hasConfigChanged()) {

            const raw = await Deno.readTextFile(this.filepath)
            const json = JSON.parse(raw)
            this.config = await AppConfig.parseAsync(json)

            const fileInfo = await Deno.stat(this.filepath)
            this.lastMtime = fileInfo.mtime

        }

        return this.config

    }


    getAccount = async (name: string) => {
        
        const config = await this.getConfig()
        
        return config.accounts.find(item => item.name === name)

    }


    getDrive = async (name: string) => {

        const config = await this.getConfig()

        const account = await this.getAccount(name)

        if (!account) {
            return null
        }

        const filepath = path.join(config.server.data_path, name, account.google_drive.credentials_file)
        const raw = await Deno.readTextFile(filepath)
        const obj = JSON.parse(raw)
        const credentials = await GoogleCredentials.parseAsync(obj)
    
        const drive = google.drive({
            version: "v3",
            auth: new JWT({
                email: credentials.client_email,
                key: credentials.private_key,
                scopes: ["https://www.googleapis.com/auth/drive.readonly"]
            })
        })
    
        return drive
    }


    getChangeToken = async (name: string) => {

        try {

            const config = await this.getConfig()
    
            const account = await this.getAccount(name)
    
            if (!account) {
                throw new Error(`Account ${name} not found`)
            }
        
            const filepath = path.join(config.server.data_path, account.name, account.google_drive.change_token_file)
            const raw = await Deno.readTextFile(filepath)
            const token = raw.trim()
        
            return token
    
        } catch (err) {
            throw new Error("Failed to get change token", {
                cause: err
            })
        }
    
    }
    
    
    
    setChangeToken = async (name: string, token: string) => {
    
        try {

            const config = await this.getConfig()

            const account = await this.getAccount(name)

            if (!account) {
                throw new Error (`Account ${name} not found`)
            }
        
            const filepath = path.join(config.server.data_path, account.name, account.google_drive.change_token_file)
        
            await Deno.writeTextFile(filepath, token)
    
        } catch (err) {
            throw new Error(`Set change token failed `, {
                cause: err
            })
        }
    
    }


}