import type { TypertRemoteInfo } from './typert.remote-client.js';
/** One member of the service model consumed by the typert loader. */
export interface ServiceMember {
    readonly kind: 'method';
    readonly name: string;
    readonly signature: string;
    readonly summary: string;
    readonly jsDoc: string;
}
/** One named type of the service model. */
export interface ServiceType {
    readonly name: string;
    readonly declaration: string;
}
/** Service documentation block. */
export interface ServiceModel {
    readonly key: string;
    readonly exportName: string;
    readonly description: string;
    readonly summary: string;
    readonly tags: readonly string[];
    readonly jsDoc: string;
    readonly members: readonly ServiceMember[];
    readonly types: readonly ServiceType[];
}
/** The TYPERT manifest exported from ./typert. */
export interface TypertHostManifest {
    readonly package: string;
    readonly face: 'host';
    readonly schemas: readonly unknown[];
    readonly invocations: TypertRemoteInfo['descriptors'];
    readonly model: {
        readonly services: readonly ServiceModel[];
        readonly events: readonly unknown[];
        readonly objects: readonly unknown[];
    };
}
export declare const TYPERT: TypertHostManifest;
export default TYPERT;
