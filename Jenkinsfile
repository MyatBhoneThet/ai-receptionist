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
                sh 'docker build -t ai-receptionist-backend ./backend'
                sh 'docker build -t ai-receptionist-frontend ./frontend'
            }
        }

        stage('Deploy Containers') {
            steps {
                sh 'docker stop ai-backend || true'
                sh 'docker rm ai-backend || true'
                sh 'docker stop ai-frontend || true'
                sh 'docker rm ai-frontend || true'

                sh 'test -f .env'
                sh 'docker network create ai-receptionist-net || true'
                sh 'docker run -d --restart unless-stopped --env-file .env --network ai-receptionist-net -p 4000:4000 --name ai-backend ai-receptionist-backend'
                sh 'docker run -d --restart unless-stopped --env-file .env --network ai-receptionist-net -p 3000:3000 --name ai-frontend ai-receptionist-frontend'
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
