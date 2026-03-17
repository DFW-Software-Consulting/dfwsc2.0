import { relations } from "drizzle-orm/relations";
import { clients, onboardingTokens, clientGroups } from "./schema";

export const onboardingTokensRelations = relations(onboardingTokens, ({one}) => ({
	client: one(clients, {
		fields: [onboardingTokens.clientId],
		references: [clients.id]
	}),
}));

export const clientsRelations = relations(clients, ({one, many}) => ({
	onboardingTokens: many(onboardingTokens),
	clientGroup: one(clientGroups, {
		fields: [clients.groupId],
		references: [clientGroups.id]
	}),
}));

export const clientGroupsRelations = relations(clientGroups, ({many}) => ({
	clients: many(clients),
}));