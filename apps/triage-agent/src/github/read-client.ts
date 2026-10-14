export interface IssueComment {
  authorLogin: string;
  body: string;
  id: number;
}

export interface CommentWindow {
  comments: IssueComment[];
  triggeringComment: IssueComment;
}

export function selectCommentWindow(
  comments: readonly IssueComment[],
  options: { maxBodyCharacters?: number; maxComments: number; triggerCommentId: number },
): CommentWindow {
  if (!Number.isInteger(options.maxComments) || options.maxComments < 1) {
    throw new Error('COMMENT_WINDOW_LIMIT_INVALID');
  }
  const triggerIndex = comments.findIndex(({ id }) => id === options.triggerCommentId);
  if (triggerIndex < 0) throw new Error('TRIGGERING_COMMENT_NOT_FOUND');
  const start = Math.max(0, triggerIndex - options.maxComments + 1);
  const end = Math.min(comments.length, start + options.maxComments);
  const maxBodyCharacters = options.maxBodyCharacters ?? 8_000;
  const selected = comments.slice(start, end).map((comment) => ({
    ...comment,
    body: comment.body.slice(0, maxBodyCharacters),
  }));
  const triggeringComment = selected.find(({ id }) => id === options.triggerCommentId);
  if (!triggeringComment) throw new Error('TRIGGERING_COMMENT_WINDOW_INVALID');
  return { comments: selected, triggeringComment };
}

export async function loadBoundedCommentWindow(input: {
  isActiveMarker(comment: IssueComment): boolean;
  fetchPage(page: number): Promise<readonly IssueComment[]>;
  maxBodyCharacters?: number;
  maxComments: number;
  maxPages: number;
  triggerCommentId: number;
}): Promise<
  CommentWindow & {
    activeMarkerComment: IssueComment | null;
    pagesRead: number;
  }
> {
  if (!Number.isInteger(input.maxPages) || input.maxPages < 1 || input.maxPages > 20) {
    throw new Error('COMMENT_PAGE_LIMIT_INVALID');
  }
  const comments: IssueComment[] = [];
  let activeMarkerComment: IssueComment | null = null;
  let foundTrigger = false;
  let pagesRead = 0;
  for (let page = 1; page <= input.maxPages; page += 1) {
    const values = await input.fetchPage(page);
    if (values.length > 100) throw new Error('COMMENT_PAGE_SIZE_INVALID');
    pagesRead = page;
    for (const comment of values) {
      const boundedComment = {
        ...comment,
        body: comment.body.slice(0, input.maxBodyCharacters ?? 8_000),
      };
      if (activeMarkerComment === null && input.isActiveMarker(comment)) {
        activeMarkerComment = boundedComment;
      }
      if (comment.id === input.triggerCommentId) foundTrigger = true;
      comments.push(boundedComment);
    }
    if ((activeMarkerComment !== null && foundTrigger) || values.length === 0) break;
  }
  const window = selectCommentWindow(comments, {
    ...(input.maxBodyCharacters === undefined
      ? {}
      : { maxBodyCharacters: input.maxBodyCharacters }),
    maxComments: input.maxComments,
    triggerCommentId: input.triggerCommentId,
  });
  return { ...window, activeMarkerComment, pagesRead };
}
