package com.plugin.core.testfixtures
//
// import io.quarkus.test.common.QuarkusTestResourceLifecycleManager
// import java.net.URI
// import org.testcontainers.containers.PostgreSQLContainer
//
// class PostgresTestResourceManager : QuarkusTestResourceLifecycleManager {
//
//    private val postgres =
//        PostgreSQLContainer("postgres:15").apply {
//            withDatabaseName("testdb")
//            withUsername("testuser")
//            withPassword("testpass")
//        }
//
//    override fun start(): Map<String, String> {
//        postgres.start()
//
//        // Convert JDBC URL to Vert.x-style URL
//        val jdbcUri = URI(postgres.jdbcUrl.removePrefix("jdbc:"))
//        val vertxUrl = "postgresql://${jdbcUri.host}:${jdbcUri.port}/${postgres.databaseName}"
//
//        return mapOf(
//            "quarkus.datasource.reactive.url" to vertxUrl,
//            "quarkus.datasource.username" to postgres.username,
//            "quarkus.datasource.password" to postgres.password,
//            "quarkus.datasource.db-kind" to "postgresql",
//            "quarkus.datasource.jdbc.url" to postgres.jdbcUrl,
//            "quarkus.liquibase.migrate-at-start" to "true",
//            "quarkus.liquibase.change-log" to "db/changelog/master.yaml",
//        )
//    }
//
//    override fun stop() {
//        postgres.stop()
//    }
// }
