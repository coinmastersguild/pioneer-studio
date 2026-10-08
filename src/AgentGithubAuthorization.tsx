import type { AgentAuthorization } from "./api";
import { githubConnectionUrl } from "./agentConnectionState";

export default function AgentGithubAuthorization({ authorization }: { authorization: AgentAuthorization }) {
  if (authorization.expires_at <= Date.now()) return <p>That sign-in link expired. Start again.</p>;
  return <p><a href={githubConnectionUrl(authorization.authorization_url, "authorize")} target="_blank" rel="noopener noreferrer">Continue to GitHub →</a><br />
    Finish in the new tab, then return here and choose “Load my repositories”. Keep this tab open to stay signed in.</p>;
}
