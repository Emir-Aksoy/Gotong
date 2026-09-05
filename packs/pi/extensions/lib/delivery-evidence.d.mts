export { jcsCanonicalize } from '@gotong/a2a';
export type AcceptanceCheck = {
    id: string;
    op: 'human';
    description: string;
} | {
    id: string;
    op: 'exists';
    path: string;
} | {
    id: string;
    op: 'equals';
    path: string;
    expected: unknown;
} | {
    id: string;
    op: 'contains';
    path: string;
    expected: string;
};
export interface CheckResult {
    id: string;
    status: 'passed' | 'failed' | 'untested';
}
export interface DeliveryEvidence {
    schema: 'gotong.evidence/v1';
    requestDigest: string;
    payloadDigest: string;
    checks: AcceptanceCheck[];
    results: CheckResult[];
    provenance: {
        taskId: string;
        by: string;
    };
}
export interface DeliveryVerification {
    consistent: boolean;
    requestMatch: 'matched' | 'mismatch' | 'not_provided';
    /** Requires the original request, successful execution, and every check passing. */
    accepted: boolean;
    passed: number;
    failed: number;
    untested: number;
}
export declare class DeliveryEvidenceError extends Error {
    readonly code = "invalid_delivery_evidence";
    constructor(message: string);
}
/** Received checks are data, never commands, paths on disk, URLs, or regexes. */
export declare function parseAcceptance(value: unknown): AcceptanceCheck[];
export declare function evaluateAcceptance(checks: readonly AcceptanceCheck[], output: unknown): CheckResult[];
export declare function buildDeliveryEvidence(request: unknown, payload: Record<string, unknown>, provenance: DeliveryEvidence['provenance']): DeliveryEvidence;
export declare function parseDeliveryEvidence(value: unknown): DeliveryEvidence;
/** Self-consistency is separate from matching the receiver's original request. */
export declare function verifyDeliveryEvidence(value: unknown, payload: Record<string, unknown>, originalRequest?: unknown): DeliveryVerification;
//# sourceMappingURL=delivery-evidence.d.ts.map