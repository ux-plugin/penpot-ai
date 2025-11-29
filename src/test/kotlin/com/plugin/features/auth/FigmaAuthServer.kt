package com.plugin.features.auth
//
// import io.quarkus.test.common.QuarkusTestResourceLifecycleManager
// import org.testcontainers.containers.GenericContainer
// import org.testcontainers.utility.DockerImageName
//
/// ** Quarkus test resource that starts a Docker container for the mock OpenAI API server. */
// class MockFigmaAuthInfra : QuarkusTestResourceLifecycleManager {
//    private lateinit var aiMockContainer: GenericContainer<*>
//
//    override fun start(): Map<String, String> {
//        val figmaImage = DockerImageName.parse("figma-mock:latest")
//        val port = 5050
//        val clientId = "figma-client-id"
//        val clientSecret = "figma-client-secret"
//
//        aiMockContainer =
//            GenericContainer(figmaImage)
//                .withExposedPorts(port)
//                .withEnv("FIGMA_MOCK_PORT", port.toString())
//                .withEnv("FIGMA_CLIENT_ID", clientId)
//                .withEnv("FIGMA_CLIENT_SECRET", clientSecret)
//
//        aiMockContainer.start()
//        aiMockContainer.followOutput { output -> println(output.utf8String.trim()) }
//
//        val mappedPort = aiMockContainer.getMappedPort(port)
//        val host = aiMockContainer.host
//
//        // Provide the endpoint as a system property /env for your app to use
//        return mapOf(
//            "quarkus.rest-client.figma-api.url" to "http://$host:$mappedPort",
//            "auth.figma.client-id" to clientId,
//            "auth.figma.client-secret" to clientSecret,
//        )
//    }
//
//    override fun stop() {
//        aiMockContainer.stop()
//    }
// }
