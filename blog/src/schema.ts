// The project's GraphQL schema (graphene-django's `schema.py`): every app's Query and Mutation classes,
// merged. Served by GraphQLView at /graphql/ (src/urls.ts); `npx ghuri graphql_schema` prints the SDL.
// The schema is built on first use, so importing it from settings.ts (GRAPHQL.SCHEMA) is fine.
import { Schema } from '@ghuri/graphql'
import { BlogMutation, BlogQuery, CommentType } from './blog/schema'

export const schema = new Schema({
  query: [BlogQuery],
  mutation: [BlogMutation],
  // Types reachable only through relations (Post.comments) must be listed.
  types: [CommentType],
})
