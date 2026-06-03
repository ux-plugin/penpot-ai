package com.plugin.api.features.completions
//
// import io.quarkus.test.common.QuarkusTestResourceLifecycleManager
// import java.io.File
// import org.testcontainers.containers.GenericContainer
// import org.testcontainers.images.builder.ImageFromDockerfile
//
// / ** Quarkus test resource that starts a Docker container for the mock OpenAI API server. */
// class MockOpenAiInfra : QuarkusTestResourceLifecycleManager {
//    private lateinit var aiMockContainer: GenericContainer<*>
//
//    override fun start(): Map<String, String> {
//        val dockerfilePath = File("./src/test/mocks/openai-mock")
//        val image = ImageFromDockerfile().withFileFromFile(".", dockerfilePath)
//        val port = 5000
//
//        aiMockContainer =
// GenericContainer(image).withExposedPorts(port).withEnv("OPENAI_MOCK_PORT", "$port")
//
//        aiMockContainer.start()
//
//        val mappedPort = aiMockContainer.getMappedPort(port)
//        val host = aiMockContainer.host
//
//        // Provide the endpoint as system property/env for your app to use
//        return mapOf("openai.api.base-url" to "http://$host:$mappedPort")
//    }
//
//    override fun stop() {
//        aiMockContainer.stop()
//    }
// }
