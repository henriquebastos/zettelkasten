/** Runtime configuration. Keep namespace capabilities in the environment, never in this file. */
export const hierarchyServiceURL =
	process.env.ZETTELKASTEN_SERVICE_URL?.trim() || 'https://zettelkasten.henriquebastos.net'
export const hierarchyNamespaceID = process.env.ZETTELKASTEN_NAMESPACE_ID?.trim() || ''
export const hierarchyCapability = process.env.ZETTELKASTEN_NAMESPACE_CAPABILITY?.trim() || ''
