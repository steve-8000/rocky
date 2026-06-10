/**
 * Re-exports from @amaze/ai.
 * All credential storage types and the AuthStorage class now live in the ai package.
 */

export type {
	ApiKeyCredential,
	AuthCredential,
	AuthCredentialEntry,
	AuthCredentialStore,
	AuthStorageData,
	AuthStorageOptions,
	OAuthCredential,
	SerializedAuthStorage,
	StoredAuthCredential,
} from "@amaze/ai";
export {
	AuthBrokerClient,
	AuthStorage,
	REMOTE_REFRESH_SENTINEL,
	RemoteAuthCredentialStore,
	SqliteAuthCredentialStore,
} from "@amaze/ai";
