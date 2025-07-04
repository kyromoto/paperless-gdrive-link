"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Config = exports.Account = exports.PaperlessNgxEndpoint = exports.DriveAccount = exports.ServerConfig = void 0;
const zod_1 = require("zod");
exports.ServerConfig = zod_1.z.object({
    port: zod_1.z.number(),
    webhook_url: zod_1.z.string()
});
exports.DriveAccount = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    name: zod_1.z.string(),
    props: zod_1.z.object({
        change_token: zod_1.z.string().optional(),
        channel_expiration_sec: zod_1.z.number().min(60).default(5 * 60),
        credentials: zod_1.z.object({
            type: zod_1.z.literal("service_account"),
            project_id: zod_1.z.string(),
            private_key_id: zod_1.z.string(),
            private_key: zod_1.z.string(),
            client_email: zod_1.z.string(),
            client_id: zod_1.z.string(),
            auth_uri: zod_1.z.string(),
            token_uri: zod_1.z.string(),
            auth_provider_x509_cert_url: zod_1.z.string(),
            universe_domain: zod_1.z.string()
        })
    })
});
exports.PaperlessNgxEndpoint = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    name: zod_1.z.string(),
    props: zod_1.z.object({
        server_url: zod_1.z.string().url(),
        credentials: zod_1.z.object({
            username: zod_1.z.string(),
            password: zod_1.z.string()
        })
    })
});
exports.Account = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    name: zod_1.z.string(),
    props: zod_1.z.object({
        paperless_endpoint_id: zod_1.z.string().uuid(),
        drive_account_id: zod_1.z.string().uuid(),
        drive_src_folder_id: zod_1.z.string(),
        drive_dst_folder_id: zod_1.z.string(),
    })
});
exports.Config = zod_1.z.object({
    server: exports.ServerConfig,
    drive_accounts: zod_1.z.array(exports.DriveAccount),
    paperless_endpoints: zod_1.z.array(exports.PaperlessNgxEndpoint),
    accounts: zod_1.z.array(exports.Account)
});
