package com.plugin.api.features.organization

import java.time.Instant

data class CreateOrganizationRequest(
    val name: String,
    val slug: String? = null,
)

data class OrganizationResponse(
    val id: String,
    val slug: String,
    val name: String,
    val role: OrgMemberRole,
    val createdAt: Instant,
)

data class ListOrganizationsResponse(val organizations: List<OrganizationResponse>)
