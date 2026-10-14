import { z } from 'zod';

const idSchema = z.number().int().positive();
const loginSchema = z.string().min(1).max(100);
const associationSchema = z.enum([
  'COLLABORATOR',
  'CONTRIBUTOR',
  'FIRST_TIMER',
  'FIRST_TIME_CONTRIBUTOR',
  'MANNEQUIN',
  'MEMBER',
  'NONE',
  'OWNER',
]);
const actorSchema = z.object({
  id: idSchema,
  login: loginSchema,
  type: z.string().max(40).optional(),
});
const labelSchema = z.union([z.string().max(100), z.object({ name: z.string().max(100) })]);
const repositorySchema = z.object({
  default_branch: z.string().min(1).max(255),
  full_name: z
    .string()
    .min(3)
    .max(200)
    .regex(/^[^/\s]+\/[^/\s]+$/u),
  id: idSchema,
  owner: z.object({ login: loginSchema }),
  visibility: z.enum(['internal', 'private', 'public']),
});
const issueSchema = z.object({
  author_association: associationSchema,
  body: z.string().max(65_536).nullable().optional(),
  id: idSchema,
  labels: z.array(labelSchema).max(100),
  number: z.number().int().positive(),
  pull_request: z.unknown().optional(),
  state: z.enum(['closed', 'open']),
  title: z.string().min(1).max(1_024),
  user: actorSchema,
});
const baseEventSchema = z.object({
  action: z.string().min(1).max(40),
  issue: issueSchema,
  repository: repositorySchema,
  sender: actorSchema,
});
const commentEventSchema = baseEventSchema.extend({
  comment: z.object({
    author_association: associationSchema,
    body: z.string().max(65_536),
    created_at: z.string().datetime({ offset: true }),
    id: idSchema,
    user: actorSchema,
  }),
});

export type ActorAssociation = z.infer<typeof associationSchema>;

export interface ProjectedActor {
  association: ActorAssociation;
  id: number;
  login: string;
  type?: string;
}

export interface ProjectedRepository {
  defaultBranch: string;
  fullName: string;
  id: number;
  ownerLogin: string;
  visibility: 'internal' | 'private' | 'public';
}

export interface ProjectedIssue {
  body: string;
  id: number;
  labels: string[];
  number: number;
  reporterLogin: string;
  state: 'closed' | 'open';
  title: string;
}

interface ProjectedEventBase {
  action: string;
  actor: ProjectedActor;
  deliveryId: string;
  eventFingerprint: string;
  issue: ProjectedIssue;
  isPullRequest: boolean;
  repository: ProjectedRepository;
}

export interface ProjectedIssueEvent extends ProjectedEventBase {
  kind: 'issues';
}

export interface ProjectedCommentEvent extends ProjectedEventBase {
  comment: {
    body: string;
    createdAt: string;
    id: number;
  };
  kind: 'issue_comment';
}

export type ProjectedGitHubEvent = ProjectedIssueEvent | ProjectedCommentEvent;

function labels(values: z.infer<typeof labelSchema>[]): string[] {
  return [...new Set(values.map((value) => (typeof value === 'string' ? value : value.name)))];
}

function projectBase(
  parsed: z.infer<typeof baseEventSchema>,
  deliveryId: string,
): Omit<ProjectedEventBase, 'eventFingerprint'> {
  return {
    action: parsed.action,
    actor: {
      association:
        parsed.sender.id === parsed.issue.user.id ? parsed.issue.author_association : 'NONE',
      id: parsed.sender.id,
      login: parsed.sender.login,
      ...(parsed.sender.type ? { type: parsed.sender.type } : {}),
    },
    deliveryId,
    issue: {
      body: parsed.issue.body ?? '',
      id: parsed.issue.id,
      labels: labels(parsed.issue.labels),
      number: parsed.issue.number,
      reporterLogin: parsed.issue.user.login,
      state: parsed.issue.state,
      title: parsed.issue.title,
    },
    isPullRequest: parsed.issue.pull_request !== undefined,
    repository: {
      defaultBranch: parsed.repository.default_branch,
      fullName: parsed.repository.full_name,
      id: parsed.repository.id,
      ownerLogin: parsed.repository.owner.login,
      visibility: parsed.repository.visibility,
    },
  };
}

export function projectGitHubEvent(
  eventName: 'issue_comment' | 'issues',
  payload: unknown,
  deliveryId: string,
): ProjectedGitHubEvent {
  const boundedDeliveryId = z.string().min(1).max(200).parse(deliveryId);
  if (eventName === 'issue_comment') {
    const parsed = commentEventSchema.parse(payload);
    const base = projectBase(parsed, boundedDeliveryId);
    return {
      ...base,
      actor: {
        ...base.actor,
        association: parsed.comment.author_association,
      },
      comment: {
        body: parsed.comment.body,
        createdAt: parsed.comment.created_at,
        id: parsed.comment.id,
      },
      eventFingerprint: [
        eventName,
        parsed.action,
        parsed.repository.id,
        parsed.issue.id,
        parsed.comment.id,
        boundedDeliveryId,
      ].join(':'),
      kind: eventName,
    };
  }

  const parsed = baseEventSchema.parse(payload);
  const base = projectBase(parsed, boundedDeliveryId);
  return {
    ...base,
    eventFingerprint: [
      eventName,
      parsed.action,
      parsed.repository.id,
      parsed.issue.id,
      boundedDeliveryId,
    ].join(':'),
    kind: eventName,
  };
}
