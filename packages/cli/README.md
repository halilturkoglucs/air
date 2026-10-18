# AIR CLI

The AIR command validates, imports, compiles, verifies, and benchmarks applications described with the Application Intermediate Representation.

```bash
npm install --global @halilturkoglucs/air
air --version
air --help
```

The current public release is `0.11.0`. For a reproducible installation, use
`npm install --global @halilturkoglucs/air@0.11.0`.

Spring discovery requires Java 17 or newer. The npm package includes AIR's pinned OpenRewrite analyzer, so Maven and an AIR source checkout are not required:

```bash
air discover spring ./legacy-service --output .air/discovery --analyzer openrewrite
air workbench .air/discovery --reviewer alice@example.com
air discovery report .air/discovery --output .air/report
```

In v0.11, discovery and report generation are supported. `air extract`, `air verify-import`, and capability adoption are preserved as experimental workflows.

Homebrew users can install the same CLI from the project tap:

```bash
brew install halilturkoglucs/tap/air-ir
air --version
air --help
```

Documentation and source: https://github.com/halilturkoglucs/air
