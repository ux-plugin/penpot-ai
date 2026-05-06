package com.plugin.core.testfixtures
//
// import io.quarkus.test.common.QuarkusTestResourceLifecycleManager
// import org.testcontainers.containers.GenericContainer
//
// class RedisTestResourceManager : QuarkusTestResourceLifecycleManager {
//
//    private val redis = GenericContainer<Nothing>("redis:7.2.4").apply { withExposedPorts(6379) }
//
//    override fun start(): Map<String, String> {
//        redis.start()
//        val host = redis.host
//        val port = redis.getMappedPort(6379)
//
//        return mapOf("quarkus.redis.hosts" to "redis://$host:$port")
//    }
//
//    override fun stop() {
//        redis.stop()
//    }
// }
