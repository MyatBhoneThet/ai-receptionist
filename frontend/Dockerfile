# Base image
FROM node:18-alpine

# Set working directory
WORKDIR /app
 
 # Add build arguments for Next.js
 ARG NEXT_PUBLIC_API_URL
 ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all files
COPY . .

# Expose port
EXPOSE 3000

# Start app
CMD ["npm", "run", "dev"]
