pipeline {
    agent any

    tools {
        nodejs 'node20'
    }

    stages {

        stage('Install Dependencies') {
            steps {
                script {
                    dir('backend') {
                        sh 'npm install'
                    }
                    dir('frontend') {
                        sh 'npm install'
                    }
                }
            }
        }

        stage('Build Frontend') {
            steps {
                dir('frontend') {
                    sh 'npm run build'
                }
            }
        }

        stage('Docker Build') {
            steps {
                withCredentials([
                    string(credentialsId: 'NEXT_PUBLIC_API_URL', variable: 'NEXT_PUBLIC_API_URL')
                ]) {
                    sh "docker build --build-arg NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} -t ai-receptionist-backend ./backend"
                    sh "docker build --build-arg NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} -t ai-receptionist-frontend ./frontend"
                }
            }
        }

        stage('Deploy Containers') {
            steps {
                withCredentials([
                    string(credentialsId: 'DATABASE_URL', variable: 'DATABASE_URL'),
                    string(credentialsId: 'OPENAI_API_KEY', variable: 'OPENAI_API_KEY'),
                    string(credentialsId: 'GOOGLE_CALENDAR_ID', variable: 'GOOGLE_CALENDAR_ID'),
                    string(credentialsId: 'GOOGLE_CLIENT_EMAIL', variable: 'GOOGLE_CLIENT_EMAIL'),
                    string(credentialsId: 'GOOGLE_PRIVATE_KEY', variable: 'GOOGLE_PRIVATE_KEY')
                ]) {
                    sh 'docker stop ai-backend || true'
                    sh 'docker rm ai-backend || true'
                    sh 'docker stop ai-frontend || true'
                    sh 'docker rm ai-frontend || true'

                    sh """
                        docker run -d -p 4000:4000 --name ai-backend \
                        -e DATABASE_URL='${DATABASE_URL}' \
                        -e OPENAI_API_KEY='${OPENAI_API_KEY}' \
                        -e GOOGLE_CALENDAR_ID='${GOOGLE_CALENDAR_ID}' \
                        -e GOOGLE_CLIENT_EMAIL='${GOOGLE_CLIENT_EMAIL}' \
                        -e GOOGLE_PRIVATE_KEY='${GOOGLE_PRIVATE_KEY}' \
                        ai-receptionist-backend
                    """

                    sh """
                        docker run -d -p 3000:3000 --name ai-frontend \
                        -e NEXT_PUBLIC_API_URL='http://localhost:4000' \
                        ai-receptionist-frontend
                    """
                }
            }
        }
    }

    post {
        always {
            cleanWs()
        }
        success {
            echo 'Pipeline completed successfully!'
        }
        failure {
            echo 'Pipeline failed. Please check the logs.'
        }
    }
}