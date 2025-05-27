# Use Node 22 LTS (alpine)
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application
COPY . .

# Install tsx globally
RUN npm install -g tsx

# Set the default command
CMD ["tsx", "src/index.ts"]
