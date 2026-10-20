/**
 * Pluggability example: inject your own Router.
 *
 * A Router is two async methods deciding where to write and where to read.
 * Here we write a trivial one (always vector+graph on write, all on read);
 * swap in e.g. a Laya-backed implementation.
 *
 * Run: `bun examples/custom-router.ts`
 */
import { createReMem, loadConfigFromEnv, type Router, type RouteDecision, type RouteState } from '../src/index'

class AlwaysEverythingRouter implements Router {
  async routeWrite(_state: RouteState): Promise<RouteDecision> {
    return { targets: ['vector', 'graph'], confidence: 1 }
  }

  async routeRead(_state: RouteState): Promise<RouteDecision> {
    return { targets: ['vector', 'graph', 'index'], confidence: 1 }
  }
}

const mem = createReMem(loadConfigFromEnv(), { router: new AlwaysEverythingRouter() })
await mem.connect()

await mem.store({ content: 'L\'utente vuole i report in italiano, con tabelle.' })
const r = await mem.recall('in che lingua preferisce i report?')
console.log(r.toPrompt())
console.log('sources:', r.sources)

await mem.close()
