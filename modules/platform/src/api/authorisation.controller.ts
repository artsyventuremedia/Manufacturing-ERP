import { RequirePermission } from '@manuling/authz';
import {
  ZodPipe,
  decodeCursor,
  formatEtag,
  pageQuerySchema,
  parseIfMatch,
  toPage,
} from '@manuling/http';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type z } from 'zod';
import { AuthorisationService } from '../application/authorisation.service.js';
import { PLATFORM_PERMISSIONS as P } from '../authorisation/permissions.js';
import {
  assignmentBody,
  cloneRoleBody,
  createRoleBody,
  fieldPoliciesBody,
  inviteUserBody,
  toAssignmentResponse,
  toConflicts,
  toFieldPolicies,
  toRoleResponse,
  toSodRuleResponse,
  toUserResponse,
  toViolations,
  updateRoleBody,
  updateSodRuleBody,
  updateUserBody,
} from './authorisation.dto.js';
import { idParam } from './dto.js';

const idPipe = new ZodPipe(idParam);

/** Roles, users, assignments, field policies and segregation of duties (step 0.5). */
@Controller('v1/platform')
export class AuthorisationController {
  constructor(private readonly service: AuthorisationService) {}

  @Get('permissions')
  @RequirePermission(P.roleRead)
  permissions() {
    return {
      items: this.service
        .listPermissions()
        .map(({ code, module, entity, action, description }) => ({
          code,
          module,
          entity,
          action,
          description,
        })),
    };
  }

  // ----- roles ---------------------------------------------------------------------

  @Get('roles')
  @RequirePermission(P.roleRead)
  async roles() {
    return { items: (await this.service.listRoles()).map(toRoleResponse) };
  }

  @Post('roles')
  @RequirePermission(P.roleManage)
  async createRole(
    @Body(new ZodPipe(createRoleBody)) body: z.output<typeof createRoleBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const role = await this.service.createRole(body);
    void reply
      .header('etag', formatEtag(role.version))
      .header('location', `/v1/platform/roles/${role.id}`);
    return toRoleResponse(role);
  }

  @Get('roles/:id')
  @RequirePermission(P.roleRead)
  async role(@Param('id', idPipe) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const role = await this.service.getRole(id);
    void reply.header('etag', formatEtag(role.version));
    return toRoleResponse(role);
  }

  @Patch('roles/:id')
  @RequirePermission(P.roleManage)
  async updateRole(
    @Param('id', idPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateRoleBody)) body: z.output<typeof updateRoleBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const role = await this.service.updateRole(id, parseIfMatch(ifMatch), body);
    void reply.header('etag', formatEtag(role.version));
    return toRoleResponse(role);
  }

  @Post('roles/:id/clone')
  @RequirePermission(P.roleManage)
  async cloneRole(
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(cloneRoleBody)) body: z.output<typeof cloneRoleBody>,
  ) {
    return toRoleResponse(await this.service.cloneRole(id, body));
  }

  @Get('roles/:id/field-policies')
  @RequirePermission(P.roleRead)
  async fieldPolicies(@Param('id', idPipe) id: string) {
    return { items: toFieldPolicies(await this.service.getFieldPolicies(id)) };
  }

  @Put('roles/:id/field-policies')
  @RequirePermission(P.roleManage)
  async replaceFieldPolicies(
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(fieldPoliciesBody)) body: z.output<typeof fieldPoliciesBody>,
  ) {
    return { items: toFieldPolicies(await this.service.replaceFieldPolicies(id, body.policies)) };
  }

  // ----- users -------------------------------------------------------------------------

  @Get('users')
  @RequirePermission(P.userRead)
  async users(@Query(new ZodPipe(pageQuerySchema)) query: z.output<typeof pageQuerySchema>) {
    const after = query.cursor ? (decodeCursor(query.cursor, 2) as [string, string]) : undefined;
    const page = toPage(await this.service.listUsers(query.limit, after), query.limit, (u) => [
      u.email,
      u.id,
    ]);
    return { ...page, items: page.items.map(toUserResponse) };
  }

  @Post('users/invitations')
  @RequirePermission(P.userInvite)
  async invite(
    @Body(new ZodPipe(inviteUserBody)) body: z.output<typeof inviteUserBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { user, warnings } = await this.service.inviteUser(body);
    void reply.header('location', `/v1/platform/users/${user.id}`);
    return { user: toUserResponse(user), warnings: toConflicts(warnings) };
  }

  @Get('users/:id')
  @RequirePermission(P.userRead)
  async user(@Param('id', idPipe) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const user = await this.service.getUser(id);
    void reply.header('etag', formatEtag(user.version));
    return toUserResponse(user);
  }

  @Patch('users/:id')
  @RequirePermission(P.userUpdate)
  async updateUser(
    @Param('id', idPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateUserBody)) body: z.output<typeof updateUserBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const user = await this.service.updateUser(id, parseIfMatch(ifMatch), body);
    void reply.header('etag', formatEtag(user.version));
    return toUserResponse(user);
  }

  // ----- assignments ---------------------------------------------------------------------

  @Post('users/:id/role-assignments')
  @RequirePermission(P.roleAssign)
  async assign(
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(assignmentBody)) body: z.output<typeof assignmentBody>,
  ) {
    const { assignment, warnings } = await this.service.assignRole(id, body);
    return { assignment: toAssignmentResponse(assignment), warnings: toConflicts(warnings) };
  }

  @Post('role-assignments/:id/revoke')
  @HttpCode(200)
  @RequirePermission(P.roleAssign)
  async revoke(@Param('id', idPipe) id: string) {
    return toAssignmentResponse(await this.service.revokeAssignment(id));
  }

  // ----- segregation of duties -----------------------------------------------------------

  @Get('sod-rules')
  @RequirePermission(P.sodRead)
  async sodRules() {
    return { items: (await this.service.listSodRules()).map(toSodRuleResponse) };
  }

  @Patch('sod-rules/:id')
  @RequirePermission(P.sodManage)
  async updateSodRule(
    @Param('id', idPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateSodRuleBody)) body: z.output<typeof updateSodRuleBody>,
  ) {
    return toSodRuleResponse(await this.service.updateSodRule(id, parseIfMatch(ifMatch), body));
  }

  @Get('sod-violations')
  @RequirePermission(P.sodRead)
  async sodViolations() {
    return { items: toViolations(await this.service.sodViolations()) };
  }
}
