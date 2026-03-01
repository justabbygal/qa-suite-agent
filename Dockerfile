FROM node:20-slim

# Install git and Claude Code CLI
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code

# Set up working directory
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .

# Git config
RUN git config --global user.name "QA Suite Agent" && \
    git config --global user.email "agent@qa-suite.dev"

EXPOSE 3000
CMD ["node", "server.js"]
