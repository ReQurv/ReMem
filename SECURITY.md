# Security Policy

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Report a potential vulnerability using the
[**Report a vulnerability** button](https://github.com/ReQurv/ReMem/security/advisories/new)
on the GitHub Security tab (Private Vulnerability Reporting), or by email to
[security@requrv.io](mailto:security@requrv.io).

You should receive an acknowledgment within 48 hours, and a substantive response
within 7 days. We will keep you informed throughout the process. Please allow
us at least 90 days to develop and ship a fix before any public disclosure.

## Scope

This policy covers the open-source ReMem library (this repository): the core
API, the router, the vector/graph/index stores, and the embedder/chat
providers.

The backends and models ReMem talks to — **Qdrant, Neo4j, OpenAI, Ollama,
S3/MinIO, WebDAV servers** — are third-party products: report issues in them to
their respective vendors.

## Known design considerations

Be aware of these intentional design choices before reporting them as issues:

- **API keys are passed in the clear** through the config object and/or
  environment variables (`OPENAI_API_KEY`, Ollama endpoints, S3/WebDAV
  credentials). ReMem is a client library: key custody is the host
  application's responsibility, and no key material is written to disk or
  logs by the library itself.
- **Backend transport security is operator-configured**: ReMem connects to
  Qdrant (REST) and Neo4j (bolt) over whatever URL/URI you provide — plain
  `http://` / `bolt://` on a local or private network is a supported setup.
  TLS, network segmentation and credentials are your responsibility when
  running remote or multi-tenant deployments.
- **Memory content is sent to your LLM providers**: knowledge-graph
  extraction on `store()` and index descriptions on `index()` call the
  configured `ChatModel`, so stored content leaves your infrastructure to the
  provider you choose (OpenAI or a local Ollama model). Data retention and
  processing are governed by that provider's policy.
- **Graceful degradation is a feature**: a downed or failing store degrades
  the `recall()` result instead of throwing. A persistent `degraded` flag is a
  health signal for your operators, not a library bug.
