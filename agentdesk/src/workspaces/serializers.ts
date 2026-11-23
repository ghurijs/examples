import { ModelSerializer, SerializerMethodField } from '@ghuri/rest'
import { Membership, Workspace } from './models'

export class WorkspaceSerializer extends ModelSerializer<Workspace> {
  static Meta = { model: Workspace, fields: ['id', 'name', 'slug', 'createdAt'], readOnlyFields: ['createdAt'] }
}

export class MembershipSerializer extends ModelSerializer<Membership> {
  username = new SerializerMethodField()

  static Meta = {
    model: Membership,
    fields: ['id', 'user', 'username', 'role', 'createdAt'],
    readOnlyFields: ['createdAt'],
  }

  async getUsername(obj: Membership): Promise<string> {
    const user = (await obj.user) as { username: string }
    return user.username
  }
}
