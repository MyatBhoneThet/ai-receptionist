pipeline {
    agent any

    /* 
       This pipeline requires the "NodeJS" plugin in Jenkins.
       You must configure a NodeJS tool named "node20" in:
       Manage Jenkins -> Global Tool Configuration -> NodeJS
       IMPORTANT: Node version must be v18.17.0+ (using v20 is recommended).
    */
    tools {
        nodejs 'node18'
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
                script {
                    dir('frontend') {
                        sh 'npm run build'
                    }
                }
            }
        }

        stage('Docker Build') {
            steps {
                // Ensure the Jenkins user has permission to use Docker
                sh 'docker-compose build'
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
