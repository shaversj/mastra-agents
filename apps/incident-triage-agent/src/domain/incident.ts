export interface IncidentDeliveryInput {
  source: string;
  deliveryId: string;
  sourceIncidentId: string;
  redactedPayload: Record<string, unknown>;
}

export interface AcceptedDelivery {
  caseId: string;
  attemptId: string;
  duplicate: boolean;
}
