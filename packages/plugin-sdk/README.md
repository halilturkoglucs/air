# AIR Plugin SDK

Versioned provider and deployment contracts for explicit AIR plugins. Plugins are loaded only when named by a deployment document and are pinned in the AIR lockfile.

AIR’s product focus is model-neutral behavior checks (`air protect` and `air check`). Provider, deployer, compiler, and generator interfaces remain supported under compatibility and security maintenance; new breadth is driven only by verification-customer needs. Check targets and policies do not load plugins or scan arbitrary installed packages.

See the [reproducible LLM verification-lift benchmark](https://github.com/halilturkoglucs/air/tree/main/benchmarks/llm-air-lift) for AIR’s model-pinned evidence. The Plugin SDK is not part of the benchmarked migration loop.
