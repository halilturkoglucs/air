# Buoy benchmark command log

The checkout and every generated bundle live in temporary directories. The reproducible command sequence was:

```bash
git clone https://github.com/ForrestKnight/buoy.git "$CHECKOUT"
git -C "$CHECKOUT" checkout 138611efc00e27e33d03b37993a85c3db3dd3ca9
git -C "$CHECKOUT" rev-parse HEAD

JAVA_HOME="$(brew --prefix openjdk@25)" "$CHECKOUT/gradlew" -p "$CHECKOUT" test
# Start disposable postgres:16, launch bootRun with its connection settings,
# wait for /actuator/health to return UP, then remove the container.

air discover spring "$CHECKOUT" --analyzer source --output "$PROOF/source-1"
air discover spring "$CHECKOUT" --analyzer source --output "$PROOF/source-2"
air discover spring "$CHECKOUT" --analyzer openrewrite --output "$PROOF/openrewrite-1"
air discover spring "$CHECKOUT" --analyzer openrewrite --output "$PROOF/openrewrite-2"
air workbench "$PROOF/reviewed" --reviewer public-corpus-reviewer
air discovery report "$PROOF/reviewed" --output "$PROOF/report"
```

Review decisions were submitted through the workbench HTTP interface after opening each finding's hash-verified source evidence. No checkout, source excerpt, database row, credential, runtime payload, or raw bundle is committed.
