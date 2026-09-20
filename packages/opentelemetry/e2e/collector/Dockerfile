ARG PLAYWRIGHT_IMAGE
FROM ${PLAYWRIGHT_IMAGE}
ARG INPUT_SHA256
LABEL org.reatom.collector.inputs="${INPUT_SHA256}"
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/tmp
WORKDIR /opt/reatom-collector
COPY package.json package-lock.json ./
RUN npm ci --omit=optional --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force \
    && ln -s /opt/reatom-collector/node_modules /node_modules \
    && node -e 'const fs = require("node:fs"); const { execFileSync } = require("node:child_process"); const { chromium } = require("playwright"); const version = require("playwright/package.json").version; if (version !== "1.60.0") throw new Error(version); fs.accessSync(chromium.executablePath(), fs.constants.X_OK); console.log(JSON.stringify({node: process.version, playwright: version, chromium: execFileSync(chromium.executablePath(), ["--version"], {encoding: "utf8"}).trim()}))'
CMD ["node", "/suite/runner.mjs", "run"]
