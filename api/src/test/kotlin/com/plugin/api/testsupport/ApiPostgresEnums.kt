package com.plugin.api.testsupport

import com.plugin.api.features.auth.core.SocialProvider
import com.plugin.api.features.organization.OrgMemberRole
import com.plugin.api.features.user.UserRole
import io.r2dbc.postgresql.codec.EnumCodec
import io.r2dbc.postgresql.extension.CodecRegistrar

/**
 * Enum codec covering every postgres enum declared by the api migrations. Tests
 * that connect to the test postgres container should pass this to `buildR2dbcDatabase`.
 */
fun apiEnumCodec(): CodecRegistrar = EnumCodec.builder()
    .withEnum("user_roles", UserRole::class.java)
    .withEnum("social_providers", SocialProvider::class.java)
    .withEnum("org_member_roles", OrgMemberRole::class.java)
    .build()
