// GraphQL for the blog app (@ghuri/graphql, graphene-django style). Combined into the project schema in
// src/schema.ts and served at /graphql/ (GraphiQL in the browser with DEBUG=true).
//
// The types reuse the REST API's rules: the same draft visibility as PostViewSet.getQueryset(), and the
// mutations validate and save through PostSerializer with the IsAuthorOrReadOnly permission class.
import { User } from '@ghuri/auth'
import {
  ConnectionField,
  Field,
  ModelMutation,
  ModelType,
  Mutation,
  Node,
  Query,
  type ResolveInfo,
  SerializerMutation,
  String as GString,
} from '@ghuri/graphql'
import { Q, type QuerySet } from '@ghuri/orm'
import { IsAuthenticated } from '@ghuri/rest'
import { Comment, Post, Tag } from './models'
import { IsAuthorOrReadOnly } from './permissions'
import { PostSerializer } from './serializers'

/** Public view of a user: never expose email, password or flags through the API. */
export class AuthorType extends ModelType {
  static Meta = { model: User, fields: ['id', 'username', 'firstName', 'lastName'] }
}

export class TagType extends ModelType {
  static Meta = {
    model: Tag,
    fields: ['id', 'name', 'slug', 'posts'],
    interfaces: [Node],
    filterFields: { name: ['exact', 'icontains'], slug: ['exact'] },
    orderBy: ['name'],
  }
}

export class CommentType extends ModelType {
  static Meta = {
    model: Comment,
    fields: ['id', 'post', 'name', 'body', 'createdAt'], // not `email` (write-only in the REST API too)
    interfaces: [Node],
    filterFields: { name: ['exact'], createdAt: ['gte', 'lte'] },
    orderBy: ['createdAt'],
  }

  /** Only approved comments, wherever comments are fetched (post.comments, node, …). */
  static getQueryset(qs: QuerySet<Comment>) {
    return qs.filter({ approved: true })
  }
}

export class PostType extends ModelType {
  static Meta = {
    model: Post,
    fields: [
      'id',
      'title',
      'slug',
      'body',
      'author',
      'tags',
      'published',
      'cover',
      'comments',
      'createdAt',
      'updatedAt',
    ],
    interfaces: [Node],
    filterFields: {
      title: ['exact', 'icontains', 'istartswith'],
      slug: ['exact'],
      published: ['exact'],
      author__username: ['exact'],
      tags__slug: ['exact', 'in'],
      createdAt: ['gte', 'lte', 'year'],
    },
    orderBy: ['createdAt', 'updatedAt', 'title'],
  }

  static fields = {
    excerpt: Field(GString, {
      description: 'The first 140 characters of the body.',
      resolve: (post: Post) => (post.body.length > 140 ? `${post.body.slice(0, 140)}…` : post.body),
    }),
  }

  /** Drafts are visible to their author (and staff) only — the same rule as PostViewSet.getQueryset(). */
  static getQueryset(qs: QuerySet<Post>, info: ResolveInfo) {
    const user = info.context.user
    if (user.isStaff) return qs
    if (user.isAuthenticated) return qs.filter(Q({ published: true }).or(Q({ author: user.pk })))
    return qs.filter({ published: true })
  }
}

export class BlogQuery extends Query {
  static fields = {
    /** allPosts(first, after, filter: { title: { icontains } }, orderBy: ["-createdAt"]) */
    allPosts: ConnectionField(PostType, { maxLimit: 50 }),
    allTags: ConnectionField(TagType),
    /** post(id: "UG9zdFR5cGU6MQ==") — a global ID. */
    post: Node.Field(PostType),
    node: Node.Field(),
    me: Field(AuthorType, {
      description: 'The authenticated user (null when anonymous).',
      resolve: (_root: unknown, _args: unknown, info: ResolveInfo) =>
        info.context.user.isAuthenticated ? info.context.user : null,
    }),
  }
}

// Cover images are uploaded through the REST API (multipart); the GraphQL mutations leave them out.
const NO_UPLOADS = ['cover', 'coverWidth', 'coverHeight'] as const

/** createPost(input: { title, slug, body, tags: ["news"], published }) — the author is the request user. */
export class CreatePost extends SerializerMutation {
  static Meta = {
    serializerClass: PostSerializer,
    modelOperations: ['create'] as const,
    permissionClasses: [IsAuthenticated],
    exclude: NO_UPLOADS,
  }

  /** Like PostViewSet.performCreate(): `serializer.save({ author: request.user })`. */
  static async performMutate(serializer: PostSerializer, info: ResolveInfo) {
    await serializer.save({ author: info.context.user })
    return { ...(await serializer.getData()), errors: [] }
  }
}

/** updatePost(input: { id, title, … }) — partial update; only the author (or staff) may change a post. */
export class UpdatePost extends SerializerMutation {
  static Meta = {
    serializerClass: PostSerializer,
    modelOperations: ['update'] as const,
    permissionClasses: [IsAuthenticated, IsAuthorOrReadOnly],
    exclude: NO_UPLOADS,
  }
}

/** deletePost(input: { id }) → { ok, deletedId }. */
export class DeletePost extends ModelMutation {
  static Meta = {
    model: Post,
    operation: 'delete' as const,
    permissionClasses: [IsAuthenticated, IsAuthorOrReadOnly],
  }
}

export class BlogMutation extends Mutation {
  static fields = {
    createPost: CreatePost.field(),
    updatePost: UpdatePost.field(),
    deletePost: DeletePost.field(),
  }
}
