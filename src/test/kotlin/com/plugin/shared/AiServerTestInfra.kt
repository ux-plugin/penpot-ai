//package com.plugin.shared
//
//import io.quarkus.test.common.QuarkusTestResourceLifecycleManager
//import org.testcontainers.containers.DockerContainer
//
//class AiServerTestInfra : QuarkusTestResourceLifecycleManager {
//
//    private lateinit var container: DockerContainer
//
//    override fun start(): Map<String, String> {
//        container = DockerContainer("dhiaeddine/figma-plugin-ai-be-contract-tester:latest")
//            .withEnv("CONTRACTS_DIR", "/contracts")
//            .withCopyFileToContainer(
//                mount(
//                    File("src/test/resources/contracts"),
//                    "/contracts"
//                ),
//                "/contracts"
//            )
//            .withExposedPorts(8080)
//        container.start()
//
//        return mapOf(
//            "engine.ai_server.host" to container.host,
//            "engine.ai_server.port" to container.getMappedPort(8080).toString()
//        )
//    }
//
//    override fun stop() {
//        container.stop()
//    }
//}