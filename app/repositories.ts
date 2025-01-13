export type ChannelRespositoryKey = string
export type ChannelRespositoryValue = { owner: string, kind: string, expiration: string, ressourceId: string }
export type ChannelRespository = Map<ChannelRespositoryKey, ChannelRespositoryValue>