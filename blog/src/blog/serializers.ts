// Serializers for the blog's REST API (@ghuri/rest, DRF style).
import { CharField, ModelSerializer, SerializerMethodField, SlugRelatedField } from '@ghuri/rest'
import { Comment, Post, Tag } from './models'

export class TagSerializer extends ModelSerializer<Tag> {
  static Meta = { model: Tag, fields: ['id', 'name', 'slug'] }
}

export class CommentSerializer extends ModelSerializer<Comment> {
  static Meta = {
    model: Comment,
    fields: ['id', 'post', 'name', 'email', 'body', 'createdAt'],
    extraKwargs: { email: { writeOnly: true } },
  }
}

export class PostSerializer extends ModelSerializer<Post> {
  static Meta = {
    model: Post,
    fields: [
      'id',
      'title',
      'slug',
      'body',
      'author',
      'authorName',
      'tags',
      'published',
      'cover',
      'coverWidth',
      'coverHeight',
      'commentCount',
      'createdAt',
      'updatedAt',
    ],
    readOnlyFields: ['author'],
  }
  authorName = new CharField({ source: 'author.username', readOnly: true })
  tags = new SlugRelatedField({ slugField: 'slug', many: true, required: false, queryset: Tag.objects.all() })
  commentCount = new SerializerMethodField()

  async getCommentCount(post: Post) {
    return Comment.objects.filter({ post: post.pk, approved: true }).count()
  }
}
