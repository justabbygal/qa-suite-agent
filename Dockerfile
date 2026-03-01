FROM node:20-slim

# Install git + util-linux (script) and Claude Code CLI
RUN apt-get update && \
    apt-get install -y git util-linux && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# Create non-root user
RUN useradd -m -u 10001 appuser

# Set up working directory
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .

# Ensure non-root user can write (repo clone/branches/files)
RUN chown -R appuser:appuser /app

# Switch to non-root
USER appuser

# Git config (as the non-root user, so it applies at runtime)
RUN git config --global user.name "QA Suite Agent" && \
    git config --global user.email "agent@qa-suite.dev"

EXPOSE 3000
CMD ["node", "server.js"]
