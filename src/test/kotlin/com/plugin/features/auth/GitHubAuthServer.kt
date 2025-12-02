package com.plugin.features.auth
//
// import io.quarkus.test.common.QuarkusTestResourceLifecycleManager
// import org.testcontainers.containers.GenericContainer
// import org.testcontainers.utility.DockerImageName
//
// / ** Quarkus test resource that starts a Docker container for the mock GitHub API server. */
// class MockGitHubAuthInfra : QuarkusTestResourceLifecycleManager {
//    private lateinit var githubMockContainer: GenericContainer<*>
//
//    override fun start(): Map<String, String> {
//        val githubImage = DockerImageName.parse("github-mock:latest")
//        val port = 5500
//        val clientId = "github-client-id"
//        val clientSecret = "github-client-secret"
//
//        githubMockContainer =
//            GenericContainer(githubImage)
//                .withExposedPorts(port)
//                .withEnv("GITHUB_MOCK_PORT", port.toString())
//                .withEnv("GITHUB_CLIENT_ID", clientId)
//                .withEnv("GITHUB_CLIENT_SECRET", clientSecret)
//
//        githubMockContainer.start()
//        githubMockContainer.followOutput { output -> println(output.utf8String.trim()) }
//
//        val mappedPort = githubMockContainer.getMappedPort(port)
//        val host = githubMockContainer.host
//
//        // Provide the endpoint as a system property /env for your app to use
//        return mapOf(
//            "quarkus.rest-client.github-api.url" to "http://$host:$mappedPort",
//            "quarkus.rest-client.github-auth.url" to "http://$host:$mappedPort",
//            "auth.github.client-id" to clientId,
//            "auth.github.client-secret" to clientSecret,
//        )
//    }
//
//    override fun stop() {
//        githubMockContainer.stop()
//    }
// }
