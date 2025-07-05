import { z } from "zod"



export type DriveAccount = z.infer<typeof DriveAccount>
export const DriveAccount = z.object({
    id: z.string().uuid(),
    name: z.string(),
    props: z.object({
        change_token: z.string().optional(),
        channel_expiration_sec: z.number().min(60).default(5 * 60),
        credentials: z.object({
            type: z.literal("service_account"),
            project_id: z.string(),
            private_key_id: z.string(),
            private_key: z.string(),
            client_email: z.string(),
            client_id: z.string(),
            auth_uri: z.string(),
            token_uri: z.string(),
            auth_provider_x509_cert_url: z.string(),
            universe_domain: z.string()
        })
    })
})


export type PaperlessNgxEndpoint = z.infer<typeof PaperlessNgxEndpoint>
export const PaperlessNgxEndpoint = z.object({
    id: z.string().uuid(),
    name: z.string(),
    props: z.object({
        server_url: z.string().url(),
        credentials: z.object({
            username: z.string(),
            password: z.string()
        })
    })
})


export type Account = z.infer<typeof Account>
export const Account = z.object({
    id: z.string().uuid(),
    name: z.string(),
    props: z.object({
        paperless_endpoint_id: z.string().uuid(),
        drive_account_id: z.string().uuid(),
        drive_src_folder_id: z.string(),
        drive_dst_folder_id: z.string(),
    })
})


export type Config = z.infer<typeof Config>
export const Config = z.object({
    drive_accounts: z.array(DriveAccount),
    paperless_endpoints: z.array(PaperlessNgxEndpoint),
    accounts: z.array(Account)
})