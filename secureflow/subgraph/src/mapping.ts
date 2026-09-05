import { BigInt, Bytes, Address } from "@graphprotocol/graph-ts"
import {
  EscrowCreated,
  EscrowUpdated,
  WorkStarted,
  DeadlineExtended,
  MilestoneSubmitted,
  MilestoneApproved,
  MilestoneRejected,
  MilestoneDisputed,
  DisputeResolved,
  EvidenceSubmitted,
  ApplicationSubmitted,
  FreelancerAccepted,
  RatingSubmitted,
} from "../generated/SecureFlow/SecureFlow"
import { Escrow, Milestone, Evidence, Application, Rating } from "../generated/schema"

export function handleEscrowCreated(event: EscrowCreated): void {
  let entity = new Escrow(event.params.escrowId.toString())
  entity.escrowId = event.params.escrowId
  entity.depositor = event.params.depositor
  entity.beneficiary = event.params.beneficiary
  entity.token = event.params.token
  entity.totalAmount = event.params.totalAmount
  entity.paidAmount = BigInt.fromI32(0)
  entity.platformFee = event.params.platformFee
  entity.deadline = event.params.deadline
  entity.status = 0 // Pending
  entity.workStarted = false
  entity.isOpenJob = event.params.isOpenJob
  entity.projectTitle = ""
  entity.projectDescription = ""
  // Convert Address[] → Bytes[] element by element (AS doesn't allow direct cast)
  let rawArbiters = event.params.arbiters
  let arbiterBytes = new Array<Bytes>(rawArbiters.length)
  for (let i = 0; i < rawArbiters.length; i++) {
    arbiterBytes[i] = rawArbiters[i] as Bytes
  }
  entity.arbiters = arbiterBytes
  entity.requiredConfirmations = event.params.requiredConfirmations
  entity.createdAt = event.block.timestamp
  entity.updatedAt = event.block.timestamp
  entity.save()
}

export function handleEscrowUpdated(event: EscrowUpdated): void {
  let entity = Escrow.load(event.params.escrowId.toString())
  if (entity) {
    entity.status = event.params.status
    entity.updatedAt = event.params.timestamp
    entity.save()
  }
}

export function handleWorkStarted(event: WorkStarted): void {
  let entity = Escrow.load(event.params.escrowId.toString())
  if (entity) {
    entity.workStarted = true
    entity.status = 1 // InProgress
    entity.updatedAt = event.block.timestamp
    entity.save()
  }
}

export function handleDeadlineExtended(event: DeadlineExtended): void {
  let entity = Escrow.load(event.params.escrowId.toString())
  if (entity) {
    entity.deadline = event.params.newDeadline
    entity.updatedAt = event.block.timestamp
    entity.save()
  }
}

export function handleMilestoneSubmitted(event: MilestoneSubmitted): void {
  let id = event.params.escrowId.toString() + "-" + event.params.milestoneIndex.toString()
  let entity = Milestone.load(id)
  if (!entity) {
    entity = new Milestone(id)
    entity.escrow = event.params.escrowId.toString()
    entity.milestoneIndex = event.params.milestoneIndex
    entity.amount = BigInt.fromI32(0)
    entity.description = event.params.description
  }
  entity.status = 1 // Submitted
  entity.submittedAt = event.params.timestamp
  entity.save()
}

export function handleMilestoneApproved(event: MilestoneApproved): void {
  let id = event.params.escrowId.toString() + "-" + event.params.milestoneIndex.toString()
  let entity = Milestone.load(id)
  if (!entity) {
    entity = new Milestone(id)
    entity.escrow = event.params.escrowId.toString()
    entity.milestoneIndex = event.params.milestoneIndex
    entity.description = ""
  }
  entity.amount = event.params.amount
  entity.status = 2 // Approved
  entity.approvedAt = event.params.timestamp

  // Update escrow paidAmount
  let escrow = Escrow.load(event.params.escrowId.toString())
  if (escrow) {
    escrow.paidAmount = escrow.paidAmount.plus(event.params.amount)
    escrow.updatedAt = event.block.timestamp
    escrow.save()
  }
  entity.save()
}

export function handleMilestoneRejected(event: MilestoneRejected): void {
  let id = event.params.escrowId.toString() + "-" + event.params.milestoneIndex.toString()
  let entity = Milestone.load(id)
  if (!entity) {
    entity = new Milestone(id)
    entity.escrow = event.params.escrowId.toString()
    entity.milestoneIndex = event.params.milestoneIndex
    entity.amount = BigInt.fromI32(0)
    entity.description = ""
  }
  entity.status = 3 // Rejected
  entity.save()
}

export function handleMilestoneDisputed(event: MilestoneDisputed): void {
  let id = event.params.escrowId.toString() + "-" + event.params.milestoneIndex.toString()
  let entity = Milestone.load(id)
  if (!entity) {
    entity = new Milestone(id)
    entity.escrow = event.params.escrowId.toString()
    entity.milestoneIndex = event.params.milestoneIndex
    entity.amount = BigInt.fromI32(0)
    entity.description = ""
  }
  entity.status = 4 // Disputed
  entity.disputedAt = event.params.timestamp
  entity.save()
}

export function handleDisputeResolved(event: DisputeResolved): void {
  let id = event.params.escrowId.toString() + "-" + event.params.milestoneIndex.toString()
  let entity = Milestone.load(id)
  if (!entity) {
    entity = new Milestone(id)
    entity.escrow = event.params.escrowId.toString()
    entity.milestoneIndex = event.params.milestoneIndex
    entity.amount = BigInt.fromI32(0)
    entity.description = ""
  }
  entity.status = 2 // Approved (finalized)
  entity.resolvedAt = event.params.timestamp
  entity.save()
}

export function handleEvidenceSubmitted(event: EvidenceSubmitted): void {
  let id = event.transaction.hash.toHex() + "-" + event.logIndex.toString()
  let entity = new Evidence(id)
  entity.escrow = event.params.escrowId.toString()
  entity.escrowId = event.params.escrowId
  entity.milestoneIndex = event.params.milestoneIndex
  entity.submitter = event.params.submitter
  entity.cid = event.params.cid
  entity.timestamp = event.block.timestamp
  entity.save()
}

export function handleApplicationSubmitted(event: ApplicationSubmitted): void {
  let id = event.params.escrowId.toString() + "-" + event.params.freelancer.toHex()
  let entity = new Application(id)
  entity.escrow = event.params.escrowId.toString()
  entity.escrowId = event.params.escrowId
  entity.freelancer = event.params.freelancer
  entity.coverLetter = event.params.coverLetter
  entity.proposedTimeline = event.params.proposedTimeline
  entity.timestamp = event.block.timestamp
  entity.save()
}

export function handleFreelancerAccepted(event: FreelancerAccepted): void {
  let entity = Escrow.load(event.params.escrowId.toString())
  if (entity) {
    entity.beneficiary = event.params.freelancer
    entity.isOpenJob = false
    entity.updatedAt = event.block.timestamp
    entity.save()
  }
}

export function handleRatingSubmitted(event: RatingSubmitted): void {
  let id = event.params.escrowId.toString() + "-" + event.params.rater.toHex()
  let entity = new Rating(id)
  entity.escrow = event.params.escrowId.toString()
  entity.escrowId = event.params.escrowId
  entity.rater = event.params.rater
  entity.rated = event.params.rated
  entity.score = event.params.score
  entity.timestamp = event.block.timestamp
  entity.save()
}
