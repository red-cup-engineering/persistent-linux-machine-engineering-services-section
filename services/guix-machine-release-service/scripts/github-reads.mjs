import {isCliEntry} from './cli-entry.mjs';
// What releasing reads from GitHub, through git and GraphQL only. The REST API budget is shared with every
// agent and tool on the account; whether a machine can release must never depend on it. Branch heads come from
// `git ls-remote`, ancestry from a commit-graph-only fetch, and pull requests from GraphQL, in the shapes the
// release scripts already read (merged_at, merge_commit_sha, base.ref, html_url, merged_by.login).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const credentials = ['-c', 'credential.helper=!gh auth git-credential', '-c', 'http.https://github.com/.extraheader='];
const remote = (repository) => `https://github.com/${repository}.git`;

function run(command, args, { input, allowFailure = false, timeout, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, timeout, maxBuffer });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`${command} ${args.find((a) => !a.startsWith('-')) ?? ''} failed (${result.status}): ${result.stderr.slice(-2000)}`);
  return result;
}

/** Same configured gh identity; no token inspection, identity switch or retry.
 * GET /rate_limit does not spend primary quota. Only these public quota fields
 * leave the observation boundary; stderr and unrelated response fields do not. */
export function githubQuota(resource, execute = run) {
  if (!['core', 'graphql'].includes(resource)) throw new Error('Unsupported GitHub quota resource');
  let response, value;
  try {
    response = execute('gh', ['api', 'rate_limit'], { allowFailure: true, timeout: 15_000, maxBuffer: 64 * 1024 });
    value = JSON.parse(response.stdout).resources?.[resource];
  } catch {}
  if (response?.status !== 0 || !value || !Number.isSafeInteger(value.remaining) || value.remaining < 0 ||
      !Number.isSafeInteger(value.reset) || value.reset <= 0)
    throw new Error('GitHub quota observation unavailable');
  return { resource, remaining: value.remaining, reset: value.reset };
}

export class GitHubRateLimitWaiting extends Error {
  constructor(resource, quota = null) {
    const waiting = { kind: 'github-rate-limit-waiting', resource,
      remaining: quota?.remaining ?? null, reset: quota?.reset ?? null,
      // A positive remaining count can coexist with a secondary limit. It is
      // never permission to retry; unknown reset evidence stays unresolved.
      retryNotBefore: quota?.remaining === 0 ? quota.reset : null };
    super(JSON.stringify(waiting)); this.name = 'GitHubRateLimitWaiting';
    this.code = 'GITHUB_RATE_LIMIT_WAITING'; this.waiting = waiting;
  }
}

export function rateLimitFailure(text, resource, observe = githubQuota) {
  if (!/rate limit/i.test(text)) return null;
  let quota = null;
  try { quota = observe(resource); } catch {}
  return new GitHubRateLimitWaiting(resource, quota);
}

function graphql(query, variables) {
  const { stdout, stderr, status } = run('gh', ['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query, variables }), allowFailure: true });
  if (status !== 0) throw rateLimitFailure(`${stdout}\n${stderr}`, 'graphql') ?? new Error('GitHub GraphQL query failed');
  const reply = JSON.parse(stdout);
  if (reply.errors?.length) {
    const messages = reply.errors.map((e) => e.message).join('; ');
    throw rateLimitFailure(messages, 'graphql') ?? new Error('GitHub GraphQL query refused');
  }
  return reply.data;
}

const FIELDS = 'number url mergedAt mergeCommit { oid } baseRefName mergedBy { login }';
const shape = (pr) => ({
  number: pr.number, html_url: pr.url, merged_at: pr.mergedAt ?? null, merge_commit_sha: pr.mergeCommit?.oid ?? null,
  base: { ref: pr.baseRefName }, merged_by: pr.mergedBy ? { login: pr.mergedBy.login } : null,
});
const split = (repository) => { const [owner, name] = repository.split('/'); return { owner, name }; };

/** A branch's head commit, or null when the branch does not exist. */
export function branchHead(repository, ref) {
  const { stdout } = run('git', [...credentials, 'ls-remote', remote(repository), `refs/heads/${ref}`]);
  return stdout.trim() ? stdout.trim().split(/\s+/u)[0] : null;
}

/** The pull requests associated with a commit. */
export function pullsForCommit(repository, sha) {
  const data = graphql(`query($owner: String!, $name: String!, $sha: GitObjectID!) { repository(owner: $owner, name: $name) {
    object(oid: $sha) { ... on Commit { associatedPullRequests(first: 20) { nodes { ${FIELDS} } } } } } }`, { ...split(repository), sha });
  return (data.repository?.object?.associatedPullRequests?.nodes ?? []).map(shape);
}

/** The most recently updated merged pull requests into a base branch. */
export function mergedPulls(repository, base, count = 50) {
  const data = graphql(`query($owner: String!, $name: String!, $base: String!, $count: Int!) { repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, baseRefName: $base, first: $count, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${FIELDS} } } } }`,
  { ...split(repository), base, count });
  return (data.repository?.pullRequests?.nodes ?? []).map(shape);
}

/** One pull request by number, or none. */
export function pullRequest(repository, number) {
  const data = graphql(`query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ${FIELDS} state headRefOid } } }`, { ...split(repository), number: Number(number) });
  const pr = data.repository?.pullRequest;
  return pr ? { ...shape(pr), state: pr.state.toLowerCase(), head: { sha: pr.headRefOid } } : null;
}

/** Fully paginated original PR/comment receiving. Only the configured provider actor's
 * evidence for this head AND machine snapshot may suppress a new assay. */
export function openPulls(repository, base, mark, count = 30, query = graphql, now = Date.now()) {
  const pulls=[],seen=new Set();let after=null;
  const pageLimit=100;
  const owned=comments=>comments.filter(comment=>comment.author?.login===actor);
  let actor;
  for(let page=0;page<pageLimit;page++){
    const data=query(`query($owner: String!, $name: String!, $base: String!, $count: Int!, $after: String) {
      viewer { login } repository(owner: $owner, name: $name) {
        pullRequests(states: OPEN, baseRefName: $base, first: $count, after: $after,
          orderBy: { field: CREATED_AT, direction: ASC }) {
          pageInfo { hasNextPage endCursor } nodes {
            id number url headRefOid isDraft isCrossRepository createdAt
            comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { body author { login } } }
          }
        }
      }
    }`,{...split(repository),base,count,after});
    if(typeof data.viewer?.login!=='string'||!data.viewer.login)throw new Error('PR receiving provider identity unavailable');
    if(actor!==undefined&&actor!==data.viewer.login)throw new Error('PR receiving provider identity changed');
    actor=data.viewer.login;
    const connection=data.repository?.pullRequests;
    if(!Array.isArray(connection?.nodes)||!connection.pageInfo)throw new Error('PR receiving repository page unavailable');
    for(const pr of connection.nodes){
      if(seen.has(pr.id))throw new Error('PR receiving repeated provider object');seen.add(pr.id);
      if(!Array.isArray(pr.comments?.nodes)||!pr.comments.pageInfo)throw new Error('PR receiving original comments unavailable');
      const comments=[...pr.comments.nodes];let cursor=pr.comments.pageInfo;
      const commentCursors=new Set();
      for(let commentPage=0;cursor?.hasNextPage;commentPage++){
        if(commentPage>=pageLimit||typeof cursor.endCursor!=='string'||commentCursors.has(cursor.endCursor))
          throw new Error('PR receiving comment pagination incomplete');
        commentCursors.add(cursor.endCursor);
        const next=query(`query($id: ID!, $after: String!) { node(id: $id) { ... on PullRequest {
          comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { body author { login } } }
        } } }`,{id:pr.id,after:cursor.endCursor}).node?.comments;
        if(!Array.isArray(next?.nodes)||!next.pageInfo)throw new Error('PR receiving comment page unavailable');
        comments.push(...next.nodes);cursor=next.pageInfo;
      }
      const evidence=owned(comments),exact=mark(pr.headRefOid);
      const retryPrefix=exact.replace('house-change-test:','house-change-retry:').replace(' -->',':');
      let retryAt=0;
      for(const comment of evidence){
        const at=comment.body.indexOf(retryPrefix);if(at<0)continue;
        const raw=comment.body.slice(at+retryPrefix.length).match(/^([0-9]+) -->/u);
        if(raw&&Number.isSafeInteger(Number(raw[1])))retryAt=Math.max(retryAt,Number(raw[1]));
      }
      pulls.push({id:pr.id,number:pr.number,html_url:pr.url,head:{sha:pr.headRefOid},
        draft:pr.isDraft,fork:pr.isCrossRepository,createdAt:pr.createdAt,
        received:evidence.some(comment=>comment.body.includes(exact)),retryAt:retryAt>now?retryAt:0});
    }
    if(connection.pageInfo.hasNextPage!==true)return pulls;
    if(typeof connection.pageInfo.endCursor!=='string'||connection.pageInfo.endCursor===after)
      throw new Error('PR receiving pagination incomplete');
    after=connection.pageInfo.endCursor;
  }
  throw new Error('PR receiving pagination bound reached');
}

/** Comment on a pull request (GraphQL addComment, by the pull request's node id). */
export function commentOnPull(id, body) {
  const posted=graphql('mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { commentEdge { node { id } } } }', { id, body }).addComment?.commentEdge?.node?.id;
  if(typeof posted!=='string')throw new Error('PR result return has no provider identity');
  const read=graphql('query($id: ID!) { viewer { login } node(id: $id) { ... on IssueComment { id body url author { login } } } }',{id:posted});
  if(read.node?.id!==posted||read.node?.body!==body||!read.viewer?.login||read.node.author?.login!==read.viewer.login)
    throw new Error('PR result return was not independently received');
  return {received:true,id:posted,url:read.node.url};
}

/** Whether `ancestor` is `descendant` or one of its ancestors, read from a commit-graph-only cache under `cache`. */
export function isAncestor(repository, ancestor, descendant, cache) {
  const directory = join(cache, `${repository.replace('/', '_')}.git`);
  if (!existsSync(directory)) { mkdirSync(cache, { recursive: true }); run('git', ['init', '-q', '--bare', directory]); }
  run('git', ['-C', directory, ...credentials, 'fetch', '-q', '--filter=tree:0', remote(repository), ancestor, descendant]);
  return run('git', ['-C', directory, 'merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true }).status === 0;
}

// Existing workflow failure observation may invoke this read-only projection.
// Importing the helper for admission never triggers an observation on its own.
if (isCliEntry(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== 'quota') throw new Error('Unsupported observation');
    process.stdout.write(JSON.stringify({ kind: 'github-quota-observation', ...githubQuota(process.argv[3]) }) + '\n');
  } catch {
    process.stderr.write('GitHub quota observation unavailable.\n'); process.exitCode = 1;
  }
}
