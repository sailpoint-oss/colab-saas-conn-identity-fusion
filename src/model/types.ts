import { Account, IdentityDocument } from 'sailpoint-api-client'

/**
 * A Map from string to object, usually representing the normalized attributes
 * of an account or an identity.
 */
export type AttributeMap = {
    [key: string]: any;
}

/**
 * The MergingMap structure passed around to a variety of methods
 */
export interface MergingMap {
    account: string[];
    identity: string;
    uidOnly: boolean;
}

export interface IdentityMatch {
    identity: IdentityDocument; 
    score: string;
}
