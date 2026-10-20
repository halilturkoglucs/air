# AIR Plugin SDK

Versioned provider and deployment contracts for explicit AIR plugins. Plugins are loaded only when named by a deployment document and are pinned in the AIR lockfile.

AIR’s v0.12 product focus is the model-neutral `air check` verification layer. Provider, deployer, compiler, and generator interfaces remain supported under compatibility and security maintenance; new breadth is driven only by verification-customer needs. Check targets and policies do not load plugins or scan arbitrary installed packages.
